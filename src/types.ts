/**
 * Shared domain types for the k6-native distributed load tester.
 *
 * The platform speaks k6's own vocabulary end to end: a test is a standard k6
 * script (inline) or a `k6 archive` tar, distributed with native execution
 * segments, controlled through the native k6 REST API, and reported with
 * native k6 output formats.
 */

export const REGIONS = ["ENAM", "WNAM", "EEUR", "WEUR", "APAC", "SAM"] as const;
export type Region = (typeof REGIONS)[number];

/**
 * Native k6 options (vus, duration, stages, thresholds, scenarios, ...).
 *
 * These are arbitrary, deeply-nested JSON that we pass through to k6 verbatim.
 * Values are typed `any` deliberately: a recursive JSON type cannot cross a
 * Durable Object RPC boundary (the RPC type mapper recurses without bound),
 * and `unknown` collapses the RPC return type to `never`.
 */
export type K6Options = Record<string, any>;

export type RunStatus =
	| "created"
	| "starting"
	| "running"
	| "stopping"
	| "completed"
	| "failed";

export type ShardStatus = "created" | "running" | "completed" | "failed";

/** How the k6 test sources are delivered to the runner. */
export type Script =
	| { type: "inline"; source: string }
	/** A `k6 archive` tar, uploaded separately and stored in R2. */
	| { type: "archive" };

/** A test definition expressed purely in k6-native terms. */
export type TestSpec = {
	script: Script;
	/** Native k6 options object (vus, duration, stages, thresholds, ...). */
	options?: K6Options;
	/** Environment variables exposed to the script (k6 `--env`). */
	env?: Record<string, string>;
	/** Extra raw k6 CLI args appended verbatim. */
	args?: string[];
	distribution: {
		regions: Region[];
		shardsPerRegion: number;
	};
};

/** One k6 process: a single execution segment within a region. */
export type Shard = {
	id: string;
	runId: string;
	region: Region;
	index: number;
	total: number;
	containerName: string;
	status: ShardStatus;
	/** k6 `--execution-segment`, e.g. "0:1/4". */
	segment: string;
	/** k6 `--execution-segment-sequence`, e.g. "0,1/4,1/2,3/4,1". */
	sequence: string;
};

export type RunRecord = {
	id: string;
	status: RunStatus;
	createdAt: string;
	updatedAt: string;
	/** Authenticated basic-auth user that created the run. */
	createdBy: string;
	spec: TestSpec;
	shards: Shard[];
};
