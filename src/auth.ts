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

/**
 * k6 cloud execution authenticates with a bearer token, not HTTP Basic Auth.
 * We intentionally reuse the existing Basic Auth credential as `user:pass`.
 */
export const requireCloudToken = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
	const token = bearerToken(c.req.header("authorization"));
	const expected = expectedCloudToken(c.env);
	if (!expected) return c.json({ error: "basic auth is not configured" }, 503);
	if (!token || !(await timingSafeEqual(token, expected))) {
		return c.json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
	}
	c.set("user", c.env.BASIC_AUTH_USER);
	await next();
});

export function expectedCloudToken(env: Env): string | null {
	if (!env.BASIC_AUTH_USER || !env.BASIC_AUTH_PASS) return null;
	return `${env.BASIC_AUTH_USER}:${env.BASIC_AUTH_PASS}`;
}

export async function validateCloudToken(env: Env, token: string | null): Promise<boolean> {
	const expected = expectedCloudToken(env);
	return Boolean(expected && token && (await timingSafeEqual(token, expected)));
}

export function bearerToken(value: string | undefined): string | null {
	const match = value?.match(/^Bearer\s+(.+)$/i);
	return match?.[1] ?? null;
}

export function wsCloudToken(request: Request): string | null {
	const authorization = request.headers.get("authorization") ?? "";
	const authMatch = authorization.match(/^token\s+(.+)$/i) ?? authorization.match(/^Bearer\s+(.+)$/i);
	if (authMatch) return authMatch[1];

	const protocol = request.headers.get("sec-websocket-protocol") ?? "";
	for (const part of protocol.split(",")) {
		const trimmed = part.trim();
		if (trimmed.startsWith("token=")) return trimmed.slice("token=".length);
	}
	return null;
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [leftHash, rightHash] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(left)),
		crypto.subtle.digest("SHA-256", encoder.encode(right)),
	]);
	const a = new Uint8Array(leftHash);
	const b = new Uint8Array(rightHash);
	let diff = left.length === right.length ? 0 : 1;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}
