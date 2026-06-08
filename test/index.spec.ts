import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readArchiveMetadata } from "../src/archive";
import { archiveSpecFromOptions } from "../src/distribution";
import { evaluateThresholds } from "../src/thresholds";

const AUTH_USER = env.BASIC_AUTH_USER;
const AUTH_PASS = env.BASIC_AUTH_PASS;
const AUTH = `Basic ${btoa(`${AUTH_USER}:${AUTH_PASS}`)}`;
const CLOUD_AUTH = `Bearer ${AUTH_USER}:${AUTH_PASS}`;

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

	it("requires bearer token auth for k6 cloud v6 routes", async () => {
		const unauthorized = await SELF.fetch("https://example.com/cloud/v6/projects");
		expect(unauthorized.status).toBe(401);

		const response = await SELF.fetch("https://example.com/cloud/v6/projects", { headers: { authorization: CLOUD_AUTH } });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { value: Array<{ id: number; is_default: boolean }> };
		expect(body.value[0]).toMatchObject({ id: 1, is_default: true });
	});

	it("accepts k6 cloud v6 upload multipart shape", async () => {
		const form = new FormData();
		form.set("name", "cloud upload test");
		form.set("script", new File([minimalArchive()], "archive.tar", { type: "application/x-tar" }));

		const response = await SELF.fetch("https://example.com/cloud/v6/projects/1/load_tests", {
			method: "POST",
			headers: { authorization: CLOUD_AUTH },
			body: form,
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { id: number; project_id: number; name: string };
		expect(body.id).toBeGreaterThan(0);
		expect(body.project_id).toBe(1);
		expect(body.name).toBe("cloud upload test");
	});

	it("reads archive metadata and maps cloud load zones to platform regions", () => {
		const metadata = readArchiveMetadata(minimalArchive());
		const spec = archiveSpecFromOptions(metadata.options, metadata.env);
		expect(spec.distribution.regions).toEqual(["ENAM", "WEUR"]);
		expect(spec.distribution.shardsPerRegion).toBe(2);
		expect(spec.options?.cloud).toBeUndefined();
		expect(spec.options?.thresholds?.http_req_failed).toEqual(["rate<0.01"]);
	});

	it("evaluates thresholds against merged summary-export metrics", () => {
		const result = evaluateThresholds(
			{ thresholds: { http_req_failed: ["rate<0.01"], http_req_duration: ["p(95)<500", { threshold: "avg<100" }] } },
			{ metrics: { http_req_failed: { rate: 0 }, http_req_duration: { "p(95)": 450, avg: 120 } } },
		);
		expect(result.passed).toBe(false);
		expect(result.results.http_req_failed["rate<0.01"]).toBe(true);
		expect(result.results.http_req_duration["p(95)<500"]).toBe(true);
		expect(result.results.http_req_duration["avg<100"]).toBe(false);
	});
});

function minimalArchive(): ArrayBuffer {
	const metadata = JSON.stringify({
		options: {
			vus: 1,
			duration: "1s",
			thresholds: { http_req_failed: ["rate<0.01"] },
			cloud: {
				distribution: { ENAM: { loadZone: "ENAM", percent: 50 }, WEUR: { loadZone: "WEUR", percent: 50 } },
				shardsPerRegion: 2,
			},
		},
		env: { EXAMPLE: "1" },
	});
	return tarFile("metadata.json", metadata);
}

function tarFile(name: string, body: string): ArrayBuffer {
	const encoder = new TextEncoder();
	const content = encoder.encode(body);
	const size = Math.ceil(content.byteLength / 512) * 512;
	const tar = new Uint8Array(512 + size + 1024);
	const header = tar.subarray(0, 512);
	writeString(header, 0, 100, name);
	writeString(header, 100, 8, "0000777");
	writeString(header, 108, 8, "0000000");
	writeString(header, 116, 8, "0000000");
	writeString(header, 124, 12, content.byteLength.toString(8).padStart(11, "0"));
	writeString(header, 136, 12, "00000000000");
	for (let i = 148; i < 156; i++) header[i] = 32;
	header[156] = "0".charCodeAt(0);
	writeString(header, 257, 6, "ustar");
	writeString(header, 263, 2, "00");
	const checksum = header.reduce((total, byte) => total + byte, 0);
	writeString(header, 148, 8, checksum.toString(8).padStart(6, "0") + "\0 ");
	tar.set(content, 512);
	return tar.buffer;
}

function writeString(bytes: Uint8Array, offset: number, length: number, value: string): void {
	const encoded = new TextEncoder().encode(value);
	bytes.set(encoded.subarray(0, length), offset);
}
