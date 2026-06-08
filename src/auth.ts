import { basicAuth } from "hono/basic-auth";
import { createMiddleware } from "hono/factory";

export type Variables = { user: string };

/**
 * HTTP Basic Auth against a single credential held in Worker secrets.
 *
 * Delegates to Hono's `basicAuth`, which performs a timing-safe credential
 * comparison and emits the standard `401` + `WWW-Authenticate` challenge.
 */
export const requireBasicAuth = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
	const username = c.env.BASIC_AUTH_USER;
	const password = c.env.BASIC_AUTH_PASS;
	if (!username || !password) {
		return c.json({ error: "basic auth is not configured" }, 503);
	}
	const guard = basicAuth({ username, password, realm: "k6" });
	return guard(c, async () => {
		c.set("user", username);
		await next();
	});
});
