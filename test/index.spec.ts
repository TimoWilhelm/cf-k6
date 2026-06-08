import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const AUTH = `Basic ${btoa("test-user:test-pass")}`;

function authed(path: string, init: RequestInit = {}): Promise<Response> {
	return SELF.fetch(`https://example.com${path}`, {
		...init,
		headers: { authorization: AUTH, ...(init.headers ?? {}) },
	});
}

describe("k6 distributed load tester API", () => {
	it("requires basic auth", async () => {
		const response = await SELF.fetch("https://example.com/v1/health");
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain("Basic");
	});

	it("serves openapi without auth", async () => {
		const response = await SELF.fetch("https://example.com/openapi.json");
		expect(response.status).toBe(200);
	});

	it("reports health and supported regions when authed", async () => {
		const response = await authed("/v1/health");
		expect(response.status).toBe(200);
		const body = (await response.json()) as { ok: boolean; regions: string[] };
		expect(body.ok).toBe(true);
		expect(body.regions).toEqual(["ENAM", "WNAM", "EEUR", "WEUR", "APAC", "SAM"]);
	});

	it("creates a distributed run with native execution segments", async () => {
		const response = await authed("/v1/tests", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				script: { type: "inline", source: "export default function () {}" },
				options: { vus: 1, duration: "1s" },
				args: ["--quiet"],
				distribution: { regions: ["ENAM", "WEUR"], shardsPerRegion: 2 },
			}),
		});

		expect(response.status).toBe(201);
		const run = (await response.json()) as {
			id: string;
			status: string;
			shards: Array<{ region: string; segment: string; sequence: string }>;
		};
		expect(run.id).toMatch(/[0-9a-f-]{36}/);
		expect(run.status).toBe("created");
		expect(run.shards).toHaveLength(4);
		expect(run.shards.map((shard) => shard.region)).toEqual(["ENAM", "ENAM", "WEUR", "WEUR"]);
		expect(run.shards[0].segment).toBe("0:1/4");
		expect(run.shards[3].segment).toBe("3/4:1");
		expect(run.shards[0].sequence).toBe("0,1/4,1/2,3/4,1");
	});

	it("rejects the reserved --address flag", async () => {
		const response = await authed("/v1/tests", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				script: { type: "inline", source: "export default function () {}" },
				args: ["--address=0.0.0.0:6565"],
			}),
		});
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain("--address is reserved");
	});

	it("lists created runs", async () => {
		await authed("/v1/tests", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ script: { type: "inline", source: "export default function () {}" } }),
		});
		const response = await authed("/v1/tests");
		expect(response.status).toBe(200);
		const body = (await response.json()) as { runs: unknown[] };
		expect(body.runs.length).toBeGreaterThan(0);
	});
});
