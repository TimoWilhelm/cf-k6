import { REGIONS, type Region, type Shard, type TestSpec } from "./types";

export const MAX_SHARDS_PER_REGION = 100;

export class SpecError extends Error {}

/**
 * Validate a test spec and return a normalized copy. Throws {@link SpecError}
 * with a human-readable message on invalid input.
 */
export function normalizeSpec(input: unknown): TestSpec {
	if (!input || typeof input !== "object") throw new SpecError("body must be a JSON object");
	const spec = input as Partial<TestSpec>;

	const script = spec.script;
	if (!script || typeof script !== "object") throw new SpecError("script is required");
	if (script.type === "inline") {
		if (typeof script.source !== "string" || !script.source.trim()) {
			throw new SpecError("script.source is required for inline scripts");
		}
	} else if (script.type !== "archive") {
		throw new SpecError('script.type must be "inline" or "archive"');
	}

	const regions = spec.distribution?.regions ?? ["ENAM"];
	if (!Array.isArray(regions) || regions.length === 0) throw new SpecError("distribution.regions must be non-empty");
	for (const region of regions) {
		if (!REGIONS.includes(region as Region)) throw new SpecError(`unsupported region: ${region}`);
	}

	const shardsPerRegion = spec.distribution?.shardsPerRegion ?? 1;
	if (!Number.isInteger(shardsPerRegion) || shardsPerRegion < 1 || shardsPerRegion > MAX_SHARDS_PER_REGION) {
		throw new SpecError(`distribution.shardsPerRegion must be an integer between 1 and ${MAX_SHARDS_PER_REGION}`);
	}

	const args = spec.args ?? [];
	if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
		throw new SpecError("args must be an array of strings");
	}
	// The platform owns the k6 REST API address so it can proxy the control plane.
	if (args.some((arg) => arg === "--address" || arg.startsWith("--address="))) {
		throw new SpecError("--address is reserved by the platform");
	}

	return {
		script,
		options: spec.options ?? {},
		env: spec.env ?? {},
		args,
		distribution: { regions: regions as Region[], shardsPerRegion },
	};
}

/**
 * Split a run into k6 execution segments. Each shard gets a contiguous,
 * non-overlapping fraction of the total work and the full shared sequence,
 * exactly as k6 expects for distributed execution.
 */
export function buildShards(runId: string, spec: TestSpec): Shard[] {
	const { regions, shardsPerRegion } = spec.distribution;
	const total = regions.length * shardsPerRegion;
	const sequence = Array.from({ length: total + 1 }, (_, i) => formatPoint(i, total)).join(",");

	const shards: Shard[] = [];
	let index = 0;
	for (const region of regions) {
		for (let perRegion = 0; perRegion < shardsPerRegion; perRegion++) {
			const start = formatPoint(index, total);
			const end = formatPoint(index + 1, total);
			const id = `${region.toLowerCase()}-${perRegion + 1}`;
			shards.push({
				id,
				runId,
				region,
				index,
				total,
				containerName: `${runId}-${id}`,
				status: "created",
				segment: `${start}:${end}`,
				sequence,
			});
			index++;
		}
	}
	return shards;
}

/** Render n/d as a reduced fraction string, matching k6's segment notation. */
function formatPoint(numerator: number, denominator: number): string {
	if (numerator === 0) return "0";
	if (numerator === denominator) return "1";
	const divisor = gcd(numerator, denominator);
	return `${numerator / divisor}/${denominator / divisor}`;
}

function gcd(left: number, right: number): number {
	while (right !== 0) {
		const next = left % right;
		left = right;
		right = next;
	}
	return Math.abs(left);
}
