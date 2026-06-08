import { Hono } from "hono";
import { requireCloudToken, type Variables } from "./auth";
import { RunNotFound } from "./coordinator";
import { SpecError } from "./shards";

type AppEnv = { Bindings: Env; Variables: Variables };

const cloud = new Hono<AppEnv>();
const coordinator = (env: Env) => env.RUN_COORDINATOR.getByName("runs");

cloud.use("/cloud/v6/*", requireCloudToken);

cloud.post("/cloud/v6/validate_options", (c) => c.json({ vuh_usage: 0, breakdown: {} }));

cloud.get("/cloud/v6/projects", (c) => c.json({ value: [{ id: 1, name: "Cloudflare Containers", is_default: true }], "@count": 1, "@nextLink": "" }));

cloud.post("/cloud/v6/projects/:projectId/load_tests", async (c) => {
	const form = await c.req.formData();
	const name = String(form.get("name") ?? "k6 test");
	const script = form.get("script");
	if (!(script instanceof File)) throw new SpecError("multipart field script is required");
	const result = await coordinator(c.env).createCloudLoadTest(Number(c.req.param("projectId")), name, await script.arrayBuffer());
	return c.json(result);
});

cloud.put("/cloud/v6/load_tests/:loadTestId/script", async (c) => {
	await coordinator(c.env).updateCloudLoadTestScript(Number(c.req.param("loadTestId")), await c.req.arrayBuffer());
	return new Response(null, { status: 204 });
});

cloud.post("/cloud/v6/load_tests/:loadTestId/start", async (c) => {
	return c.json(await coordinator(c.env).startCloudTestRun(Number(c.req.param("loadTestId")), c.req.url));
});

cloud.get("/cloud/v6/test_runs/:testRunId", async (c) => {
	return c.json(await coordinator(c.env).getCloudTestRun(Number(c.req.param("testRunId")), c.req.url));
});

cloud.post("/cloud/v6/test_runs/:testRunId/abort", async (c) => {
	await coordinator(c.env).abortCloudTestRun(Number(c.req.param("testRunId")));
	return new Response(null, { status: 204 });
});

cloud.onError((error, c) => {
	if (error instanceof SpecError) return c.json({ error: { message: error.message } }, 400);
	if (error instanceof RunNotFound) return c.json({ error: { message: error.message } }, 404);
	console.error(JSON.stringify({ msg: "cloud v6 error", error: String(error) }));
	return c.json({ error: { message: "internal error" } }, 500);
});

export default cloud;
