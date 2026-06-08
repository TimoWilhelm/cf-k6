import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireBasicAuth, type Variables } from "./auth";
import { RunNotFound, type StatusPatch } from "./coordinator";
import { openApiDocument } from "./openapi";
import { normalizeSpec, SpecError } from "./shards";
import { REGIONS, type Region, type TestSpec } from "./types";

type AppEnv = { Bindings: Env; Variables: Variables };

const app = new Hono<AppEnv>();

const coordinator = (env: Env) => env.RUN_COORDINATOR.getByName("runs");

app.get("/openapi.json", () => Response.json(openApiDocument()));

// Everything below requires HTTP Basic Auth.
app.use("/v1/*", requireBasicAuth);

app.get("/v1/health", (c) => c.json({ ok: true, regions: REGIONS }));

app.get("/v1/tests", async (c) => {
	// RunRecord embeds the recursive JsonValue (k6 options), which overwhelms
	// Hono's typed c.json walker, so run payloads are returned via Response.json.
	return Response.json({ runs: await coordinator(c.env).listRuns() });
});

app.post("/v1/tests", async (c) => {
	const contentType = c.req.header("content-type") ?? "";

	if (contentType.includes("application/json")) {
		const spec = normalizeSpec(await c.req.json());
		const run = await coordinator(c.env).createRun(spec, c.get("user"));
		return Response.json(run, { status: 201 });
	}

	if (contentType.includes("tar") || contentType.includes("octet-stream")) {
		if (!c.req.raw.body) throw new SpecError("archive body is required");
		const spec = archiveSpecFromQuery(c.req.query());
		const run = await coordinator(c.env).createRun(spec, c.get("user"));
		await c.env.ARTIFACTS.put(`runs/${run.id}/archive.tar`, c.req.raw.body, {
			httpMetadata: { contentType: "application/x-tar" },
		});
		return Response.json(run, { status: 201 });
	}

	throw new SpecError("Content-Type must be application/json (inline) or application/x-tar (archive)");
});

app.get("/v1/tests/:id", async (c) => {
	const run = await coordinator(c.env).getRun(c.req.param("id"));
	return run ? Response.json(run) : c.json({ error: "run not found" }, 404);
});

app.post("/v1/tests/:id/start", async (c) => {
	const id = c.req.param("id");
	const run = await coordinator(c.env).getRun(id);
	if (!run) throw new RunNotFound(id);

	const workflow = await startWorkflow(c.env, id);
	return Response.json({ run, workflow });
});

app.post("/v1/tests/:id/stop", async (c) => {
	return Response.json(await coordinator(c.env).stopRun(c.req.param("id")));
});

app.get("/v1/tests/:id/status", async (c) => {
	return c.json(await coordinator(c.env).getStatus(c.req.param("id")));
});

app.patch("/v1/tests/:id/status", async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as StatusPatch;
	return c.json(await coordinator(c.env).patchStatus(c.req.param("id"), body));
});

app.get("/v1/tests/:id/metrics", async (c) => {
	return c.json(await coordinator(c.env).getMetrics(c.req.param("id")));
});

app.get("/v1/tests/:id/summary", (c) => artifact(c.env, `runs/${c.req.param("id")}/summary.json`, "application/json"));

app.get("/v1/tests/:id/shards/:shard/results", (c) =>
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
