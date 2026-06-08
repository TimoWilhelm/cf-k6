import { validateCloudToken, wsCloudToken } from "./auth";

const coordinator = (env: Env) => env.RUN_COORDINATOR.getByName("runs");

export async function handleCloudLogs(request: Request, env: Env): Promise<Response> {
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		return Response.json({ error: "websocket upgrade required" }, { status: 426 });
	}
	if (!(await validateCloudToken(env, wsCloudToken(request)))) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}
	return coordinator(env).fetch(request);
}
