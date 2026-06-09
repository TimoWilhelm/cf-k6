import { z } from "@hono/zod-openapi";
import { MAX_SHARDS_PER_REGION } from "./shards";
import { REGIONS } from "./types";

export const ErrorSchema = z.object({
	error: z.string().openapi({ example: "run not found" }),
}).openapi("Error");

export const RegionSchema = z.enum(REGIONS).openapi("Region", {
	example: "ENAM",
});

const JsonObjectSchema = z.record(z.string(), z.any()).openapi({
	type: "object",
	additionalProperties: true,
});

export const InlineScriptSchema = z.object({
	type: z.literal("inline"),
	source: z.string().min(1).openapi({
		example: 'import http from "k6/http";\nexport default function(){ http.get("https://test.k6.io"); }',
	}),
}).openapi("InlineScript");

export const ArchiveScriptSchema = z.object({
	type: z.literal("archive"),
}).openapi("ArchiveScript");

export const ScriptSchema = z.discriminatedUnion("type", [InlineScriptSchema, ArchiveScriptSchema]).openapi("Script");

export const DistributionInputSchema = z.object({
	regions: z.array(RegionSchema).min(1).optional().openapi({ example: ["ENAM", "WEUR"] }),
	shardsPerRegion: z.number().int().min(1).max(MAX_SHARDS_PER_REGION).optional().openapi({ example: 2 }),
}).openapi("DistributionInput");

export const DistributionSchema = z.object({
	regions: z.array(RegionSchema).min(1).openapi({ example: ["ENAM", "WEUR"] }),
	shardsPerRegion: z.number().int().min(1).max(MAX_SHARDS_PER_REGION).openapi({ example: 2 }),
}).openapi("Distribution");

export const TestSpecInputSchema = z.object({
	script: ScriptSchema,
	options: JsonObjectSchema.optional().openapi({ description: "Native k6 options object passed through verbatim." }),
	env: z.record(z.string(), z.string()).optional().openapi({ example: { BASE_URL: "https://example.com" } }),
	args: z.array(z.string()).optional().openapi({ example: ["--tag", "source=api"] }),
	distribution: DistributionInputSchema.optional(),
}).openapi("TestSpecInput");

export const TestSpecSchema = z.object({
	script: ScriptSchema,
	options: JsonObjectSchema,
	env: z.record(z.string(), z.string()),
	args: z.array(z.string()),
	distribution: DistributionSchema,
}).openapi("TestSpec");

export const RunStatusSchema = z.enum(["created", "starting", "running", "stopping", "completed", "failed"]).openapi("RunStatus");
export const ShardStatusSchema = z.enum(["created", "running", "completed", "failed"]).openapi("ShardStatus");

export const ShardSchema = z.object({
	id: z.string().openapi({ example: "ENAM-0" }),
	runId: z.string().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
	region: RegionSchema,
	index: z.number().int().openapi({ example: 0 }),
	total: z.number().int().openapi({ example: 4 }),
	containerName: z.string().openapi({ example: "run-550e8400-ENAM-0" }),
	status: ShardStatusSchema,
	segment: z.string().openapi({ example: "0:1/4" }),
	sequence: z.string().openapi({ example: "0,1/4,1/2,3/4,1" }),
}).openapi("Shard");

export const RunRecordSchema = z.object({
	id: z.string().openapi({ example: "550e8400-e29b-41d4-a716-446655440000" }),
	status: RunStatusSchema,
	createdAt: z.string().datetime().openapi({ example: "2026-06-09T12:00:00.000Z" }),
	updatedAt: z.string().datetime().openapi({ example: "2026-06-09T12:00:00.000Z" }),
	createdBy: z.string().openapi({ example: "loadtester" }),
	spec: TestSpecSchema,
	shards: z.array(ShardSchema),
}).openapi("RunRecord");

export const HealthSchema = z.object({
	ok: z.literal(true),
	regions: z.array(RegionSchema),
}).openapi("Health");

export const RunsListSchema = z.object({
	runs: z.array(RunRecordSchema),
}).openapi("RunsList");

export const IdParamSchema = z.object({
	id: z.string().min(1).openapi({
		param: { name: "id", in: "path" },
		example: "550e8400-e29b-41d4-a716-446655440000",
	}),
});

export const ShardParamSchema = IdParamSchema.extend({
	shard: z.string().min(1).openapi({
		param: { name: "shard", in: "path" },
		example: "ENAM-0",
	}),
});

export const ArchiveQuerySchema = z.object({
	regions: z.string().optional().openapi({
		param: { name: "regions", in: "query" },
		example: "ENAM,APAC",
	}),
	shardsPerRegion: z.coerce.number().int().min(1).max(MAX_SHARDS_PER_REGION).optional().openapi({
		param: { name: "shardsPerRegion", in: "query" },
		example: 2,
	}),
	env: z.string().optional().openapi({
		param: { name: "env", in: "query" },
		example: '{"BASE_URL":"https://example.com"}',
	}),
	args: z.string().optional().openapi({
		param: { name: "args", in: "query" },
		example: '["--tag","source=api"]',
	}),
});

export const StatusPatchSchema = z.object({
	data: z.object({
		type: z.string().optional(),
		id: z.string().optional(),
		attributes: z.object({
			paused: z.boolean().optional(),
			vus: z.number().optional(),
			stopped: z.boolean().optional(),
		}).optional(),
	}).optional(),
}).openapi("StatusPatch");

export const AggregateStatusSchema = z.object({
	data: z.object({
		type: z.literal("status"),
		id: z.literal("default"),
		attributes: z.object({
			running: z.boolean(),
			paused: z.boolean(),
			tainted: z.boolean(),
			vus: z.number(),
		}),
	}),
	meta: z.object({
		shards: z.array(z.object({
			id: z.string(),
			region: z.string(),
			status: z.string(),
			reachable: z.boolean(),
		})),
	}),
}).openapi("AggregateStatus");

export const WorkflowStartSchema = z.object({
	run: RunRecordSchema,
	workflow: z.object({
		id: z.string(),
		status: z.any(),
	}),
}).openapi("WorkflowStart");

export const OpenJsonObjectSchema = JsonObjectSchema.openapi("OpenJsonObject");
export const NdjsonSchema = z.string().openapi("Ndjson", { example: '{"type":"Point","metric":"http_reqs"}\n' });
export const TarArchiveSchema = z.string().openapi({ format: "binary" });
