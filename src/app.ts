import { swaggerUI } from "@hono/swagger-ui";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireBasicAuth, type Variables } from "./auth";
import cloudV6 from "./cloudv6";
import { handleCloudLogs } from "./cloudlogs";
import { RunNotFound, type StatusPatch } from "./coordinator";
import { normalizeSpec, SpecError } from "./shards";
import {
	AggregateStatusSchema,
	ArchiveQuerySchema,
	HealthSchema,
	IdParamSchema,
	NdjsonSchema,
	OpenJsonObjectSchema,
	RunRecordSchema,
	RunsListSchema,
	ShardParamSchema,
	StatusPatchSchema,
	TarArchiveSchema,
	TestSpecInputSchema,
	WorkflowStartSchema,
} from "./schemas";
import { REGIONS, type Region, type TestSpec } from "./types";

type AppEnv = { Bindings: Env; Variables: Variables };

const app = new OpenAPIHono<AppEnv>({
	defaultHook: (result, c) => {
		if (result.success) return;
		return c.json({ error: result.error.issues[0]?.message ?? "invalid request" }, 400);
	},
});

const coordinator = (env: Env) => env.RUN_COORDINATOR.getByName("runs");
const basicSecurity = [{ basicAuth: [] }];

app.openAPIRegistry.registerComponent("securitySchemes", "basicAuth", {
	type: "http",
	scheme: "basic",
});

app.doc31("/openapi.json", {
	openapi: "3.1.0",
	info: {
		title: "k6 Distributed Load Tester",
		version: "1.0.0",
		description:
			"Run standard k6 tests distributed across Cloudflare regions. Lifecycle is managed by Cloudflare Workflows. Authenticated with HTTP Basic Auth.\n\n" +
			"Not affiliated with or endorsed by Grafana Labs or the k6 project (https://k6.io).",
	},
	security: [{ basicAuth: [] }],
	"x-supported-regions": REGIONS,
});

app.get("/docs", swaggerUI({ url: "/openapi.json" }));

app.route("/", cloudV6);
app.get("/api/v1/tail", (c) => handleCloudLogs(c.req.raw, c.env));

const errorResponse = {
	description: "Error response",
};

const healthRoute = createRoute({
	method: "get",
	path: "/v1/health",
	security: basicSecurity,
	responses: {
		200: { content: { "application/json": { schema: HealthSchema } }, description: "Health check and supported regions" },
		503: errorResponse,
	},
});

const listTestsRoute = createRoute({
	method: "get",
	path: "/v1/tests",
	security: basicSecurity,
	responses: {
		200: { content: { "application/json": { schema: RunsListSchema } }, description: "List runs" },
		503: errorResponse,
	},
});

const createTestRoute = createRoute({
	method: "post",
	path: "/v1/tests",
	security: basicSecurity,
	request: {
		query: ArchiveQuerySchema,
		body: {
			content: {
				"application/json": { schema: TestSpecInputSchema },
				"application/x-tar": { schema: TarArchiveSchema },
				"application/octet-stream": { schema: TarArchiveSchema },
			},
			description: "Inline JSON test spec or k6 archive tar body.",
		},
	},
	responses: {
		201: { content: { "application/json": { schema: RunRecordSchema } }, description: "Created run" },
		400: errorResponse,
		503: errorResponse,
	},
});

const getTestRoute = createRoute({
	method: "get",
	path: "/v1/tests/{id}",
	security: basicSecurity,
	request: { params: IdParamSchema },
	responses: {
		200: { content: { "application/json": { schema: RunRecordSchema } }, description: "Run record" },
		404: errorResponse,
		503: errorResponse,
	},
});

const startTestRoute = createRoute({
	method: "post",
	path: "/v1/tests/{id}/start",
	security: basicSecurity,
	request: { params: IdParamSchema },
	responses: {
		200: { content: { "application/json": { schema: WorkflowStartSchema } }, description: "Workflow instance for the run lifecycle" },
		404: errorResponse,
		503: errorResponse,
	},
});

const stopTestRoute = createRoute({
	method: "post",
	path: "/v1/tests/{id}/stop",
	security: basicSecurity,
	request: { params: IdParamSchema },
	responses: {
		200: { content: { "application/json": { schema: RunRecordSchema } }, description: "Stopped run" },
		404: errorResponse,
		503: errorResponse,
	},
});

const getStatusRoute = createRoute({
	method: "get",
	path: "/v1/tests/{id}/status",
	security: basicSecurity,
	request: { params: IdParamSchema },
	responses: {
		200: { content: { "application/json": { schema: AggregateStatusSchema } }, description: "Aggregated k6 /v1/status" },
		404: errorResponse,
		503: errorResponse,
	},
});

const patchStatusRoute = createRoute({
	method: "patch",
	path: "/v1/tests/{id}/status",
	security: basicSecurity,
	request: {
		params: IdParamSchema,
		body: { content: { "application/json": { schema: StatusPatchSchema } } },
	},
	responses: {
		200: { content: { "application/json": { schema: AggregateStatusSchema } }, description: "Updated aggregate status" },
		400: errorResponse,
		404: errorResponse,
		503: errorResponse,
	},
});

const getMetricsRoute = createRoute({
	method: "get",
	path: "/v1/tests/{id}/metrics",
	security: basicSecurity,
	request: { params: IdParamSchema },
	responses: {
		200: { content: { "application/json": { schema: OpenJsonObjectSchema } }, description: "Aggregated k6 /v1/metrics" },
		404: errorResponse,
		503: errorResponse,
	},
});

const getSummaryRoute = createRoute({
	method: "get",
	path: "/v1/tests/{id}/summary",
	security: basicSecurity,
	request: { params: IdParamSchema },
	responses: {
		200: { content: { "application/json": { schema: OpenJsonObjectSchema } }, description: "Exact merged end-of-test k6 summary-export JSON" },
		404: errorResponse,
		503: errorResponse,
	},
});

const getShardResultsRoute = createRoute({
	method: "get",
	path: "/v1/tests/{id}/shards/{shard}/results",
	security: basicSecurity,
	request: { params: ShardParamSchema },
	responses: {
		200: { content: { "application/x-ndjson": { schema: NdjsonSchema } }, description: "Raw k6 JSON output for one shard" },
		404: errorResponse,
		503: errorResponse,
	},
});

// Everything below requires HTTP Basic Auth.
app.use("/v1/*", requireBasicAuth);

app.openapi(healthRoute, (c) => c.json({ ok: true, regions: REGIONS }, 200));

app.openapi(listTestsRoute, async (c) => c.json({ runs: await coordinator(c.env).listRuns() }, 200));

app.openapi(createTestRoute, async (c) => {
	const contentType = c.req.header("content-type") ?? "";

	if (contentType.includes("application/json")) {
		const spec = normalizeSpec(await c.req.json());
		const run = await coordinator(c.env).createRun(spec, c.get("user"));
		return c.json(run, 201);
	}

	if (contentType.includes("tar") || contentType.includes("octet-stream")) {
		if (!c.req.raw.body) throw new SpecError("archive body is required");
		const spec = archiveSpecFromQuery(c.req.query());
		const run = await coordinator(c.env).createRun(spec, c.get("user"));
		await c.env.ARTIFACTS.put(`runs/${run.id}/archive.tar`, c.req.raw.body, {
			httpMetadata: { contentType: "application/x-tar" },
		});
		return c.json(run, 201);
	}

	throw new SpecError("Content-Type must be application/json (inline) or application/x-tar (archive)");
});

app.openapi(getTestRoute, async (c) => {
	const run = await coordinator(c.env).getRun(c.req.param("id"));
	return run ? Response.json(run) : c.json({ error: "run not found" }, 404);
});

app.openapi(startTestRoute, async (c) => {
	const id = c.req.param("id");
	const run = await coordinator(c.env).getRun(id);
	if (!run) throw new RunNotFound(id);

	const workflow = await startWorkflow(c.env, id);
	return c.json({ run, workflow }, 200);
});

app.openapi(stopTestRoute, async (c) => c.json(await coordinator(c.env).stopRun(c.req.param("id")), 200));

app.openapi(getStatusRoute, async (c) => c.json(await coordinator(c.env).getStatus(c.req.param("id")), 200));

app.openapi(patchStatusRoute, async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as StatusPatch;
	return c.json(await coordinator(c.env).patchStatus(c.req.param("id"), body), 200);
});

app.openapi(getMetricsRoute, async (c) => c.json(await coordinator(c.env).getMetrics(c.req.param("id")), 200));

app.openapi(getSummaryRoute, (c) => artifact(c.env, `runs/${c.req.param("id")}/summary.json`, "application/json"));

app.openapi(getShardResultsRoute, (c) =>
	artifact(c.env, `runs/${c.req.param("id")}/shards/${c.req.param("shard")}/results.ndjson`, "application/x-ndjson"),
);

// Passthrough to a single shard's native k6 REST API.
app.all("/v1/tests/:id/shards/:shard/k6/v1/:path{.+}", async (c) => {
	const method = c.req.method;
	const body = method === "GET" || method === "HEAD" ? null : await c.req.arrayBuffer();
	return coordinator(c.env).proxyShard(c.req.param("id"), c.req.param("shard"), c.req.param("path"), method, body);
});

app.onError((error, c) => {
	if (error instanceof HTTPException) return error.getResponse(); // e.g. the 401 from basicAuth
	if (error instanceof SpecError) return c.json({ error: error.message }, 400);
	if (error instanceof RunNotFound) return c.json({ error: error.message }, 404);
	console.error(JSON.stringify({ msg: "unhandled error", error: String(error) }));
	return c.json({ error: "internal error" }, 500);
});

async function artifact(env: Env, key: string, contentType: string): Promise<Response> {
	const object = await env.ARTIFACTS.get(key);
	if (!object) return Response.json({ error: "artifact not found" }, { status: 404 });
	return new Response(object.body, { headers: { "content-type": contentType } });
}

function archiveSpecFromQuery(query: Record<string, string>): TestSpec {
	const regions = (query.regions ?? "ENAM").split(",").map((value) => value.trim()).filter(Boolean);
	return normalizeSpec({
		script: { type: "archive" },
		distribution: {
			regions: regions as Region[],
			shardsPerRegion: query.shardsPerRegion ? Number(query.shardsPerRegion) : 1,
		},
		env: parseJsonQuery(query.env),
		args: parseJsonQuery(query.args),
	});
}

function parseJsonQuery(value: string | undefined): unknown {
	if (!value) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		throw new SpecError("env and args query params must be valid JSON");
	}
}

async function startWorkflow(env: Env, runId: string): Promise<{ id: string; status: unknown }> {
	try {
		const instance = await env.K6_RUN_WORKFLOW.create({ id: runId, params: { runId } });
		return { id: instance.id, status: await instance.status() };
	} catch {
		const instance = await env.K6_RUN_WORKFLOW.get(runId);
		return { id: instance.id, status: await instance.status() };
	}
}

export default app;
