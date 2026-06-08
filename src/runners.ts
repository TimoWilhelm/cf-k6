import { Container } from "@cloudflare/containers";
import type { Region } from "./types";

/**
 * One Container class per region. Cloudflare pins each class to its region via
 * the `constraints.regions` setting in wrangler.jsonc, which is how we place k6
 * load generators close to (or far from) the target under test.
 */
class K6Runner extends Container {
	defaultPort = 8788;
	sleepAfter = "30m";
}

export class K6RunnerENAM extends K6Runner {}
export class K6RunnerWNAM extends K6Runner {}
export class K6RunnerEEUR extends K6Runner {}
export class K6RunnerWEUR extends K6Runner {}
export class K6RunnerAPAC extends K6Runner {}
export class K6RunnerSAM extends K6Runner {}

export function runnerNamespace(env: Env, region: Region): DurableObjectNamespace<Container> {
	switch (region) {
		case "ENAM":
			return env.K6_RUNNER_ENAM as unknown as DurableObjectNamespace<Container>;
		case "WNAM":
			return env.K6_RUNNER_WNAM as unknown as DurableObjectNamespace<Container>;
		case "EEUR":
			return env.K6_RUNNER_EEUR as unknown as DurableObjectNamespace<Container>;
		case "WEUR":
			return env.K6_RUNNER_WEUR as unknown as DurableObjectNamespace<Container>;
		case "APAC":
			return env.K6_RUNNER_APAC as unknown as DurableObjectNamespace<Container>;
		case "SAM":
			return env.K6_RUNNER_SAM as unknown as DurableObjectNamespace<Container>;
	}
}
