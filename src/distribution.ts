import { normalizeSpec, SpecError } from "./shards";
import { REGIONS, type K6Options, type Region, type TestSpec } from "./types";

type CloudOptions = {
	distribution?: Record<string, { loadZone?: string; percent?: number }>;
	shardsPerRegion?: number;
};

export function archiveSpecFromOptions(options: K6Options | undefined, env: Record<string, string> | undefined): TestSpec {
	const cloud = (options?.cloud ?? {}) as CloudOptions;
	return normalizeSpec({
		script: { type: "archive" },
		options: stripCloudExecutionOptions(options ?? {}),
		env: env ?? {},
		distribution: {
			regions: regionsFromCloudDistribution(cloud.distribution),
			shardsPerRegion: cloud.shardsPerRegion ?? 1,
		},
	});
}

export function regionsFromCloudDistribution(distribution: CloudOptions["distribution"]): Region[] {
	if (!distribution || Object.keys(distribution).length === 0) return ["ENAM"];
	const regions: Region[] = [];
	for (const [key, entry] of Object.entries(distribution)) {
		const value = entry.loadZone ?? key;
		if (!REGIONS.includes(value as Region)) throw new SpecError(`unsupported cloud loadZone: ${value}`);
		regions.push(value as Region);
	}
	return regions;
}

function stripCloudExecutionOptions(options: K6Options): K6Options {
	const clone = structuredClone(options) as K6Options;
	if (clone.cloud && typeof clone.cloud === "object") delete clone.cloud;
	return clone;
}
