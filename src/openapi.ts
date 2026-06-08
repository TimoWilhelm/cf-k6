import { REGIONS } from "./types";

/** Minimal but accurate OpenAPI 3.1 description of the control plane. */
export function openApiDocument(): unknown {
	return {
		openapi: "3.1.0",
		info: {
			title: "k6 Distributed Load Tester",
			version: "1.0.0",
			description: "Run standard k6 tests distributed across Cloudflare regions. Lifecycle is managed by Cloudflare Workflows. Authenticated with HTTP Basic Auth.",
		},
		components: {
			securitySchemes: { basicAuth: { type: "http", scheme: "basic" } },
		},
		security: [{ basicAuth: [] }],
		paths: {
			"/v1/health": { get: { summary: "Health check and supported regions" } },
			"/v1/tests": {
				get: { summary: "List runs" },
				post: {
					summary: "Create a run from an inline k6 script (application/json) or a k6 archive tar (application/x-tar)",
				},
			},
			"/v1/tests/{id}": { get: { summary: "Get a run record" } },
			"/v1/tests/{id}/start": { post: { summary: "Create the Workflow instance that manages this run lifecycle" } },
			"/v1/tests/{id}/stop": { post: { summary: "Stop all shards (native k6 stop)" } },
			"/v1/tests/{id}/status": {
				get: { summary: "Aggregated k6 /v1/status" },
				patch: { summary: "Forward pause/resume/scale to all shards" },
			},
			"/v1/tests/{id}/metrics": { get: { summary: "Aggregated k6 /v1/metrics (live; trend percentiles approximate)" } },
			"/v1/tests/{id}/summary": { get: { summary: "Exact merged end-of-test summary (k6 summary-export JSON)" } },
			"/v1/tests/{id}/shards/{shard}/results": { get: { summary: "Raw k6 JSON output (NDJSON) for one shard" } },
			"/v1/tests/{id}/shards/{shard}/k6/v1/{path}": {
				get: { summary: "Passthrough to one shard's native k6 REST API" },
				patch: { summary: "Passthrough to one shard's native k6 REST API" },
				put: { summary: "Passthrough to one shard's native k6 REST API" },
			},
		},
		"x-supported-regions": REGIONS,
	};
}
