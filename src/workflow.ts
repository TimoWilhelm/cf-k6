import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { RunStatus, ShardStatus } from "./types";

export type K6RunWorkflowParams = { runId: string };

type PollResult = { shardId: string; status: ShardStatus; running: boolean; error?: string };
type WorkflowResult = { runId: string; status: RunStatus };

const POLL_INTERVAL = "15 seconds";
const MAX_POLLS = 1_440; // 6 hours at 15 seconds; sleep steps do not count toward the step limit.

const STATE_STEP = {
	retries: { limit: 5, delay: "5 seconds", backoff: "exponential" },
	timeout: "2 minutes",
} as const;

const LAUNCH_STEP = {
	retries: { limit: 8, delay: "5 seconds", backoff: "exponential" },
	timeout: "5 minutes",
} as const;

const COLLECT_STEP = {
	retries: { limit: 3, delay: "5 seconds", backoff: "linear" },
	timeout: "5 minutes",
} as const;

const FINALIZE_STEP = {
	retries: { limit: 10, delay: "10 seconds", backoff: "exponential" },
	timeout: "30 minutes",
} as const;

const coordinator = (env: Env) => env.RUN_COORDINATOR.getByName("runs");

/**
 * Durable lifecycle manager for one distributed k6 run.
 *
 * Fan-out pattern:
 *  1. mark run starting and get deterministic shard IDs
 *  2. launch one Workflow step per shard in parallel
 *  3. poll/collect one Workflow step per shard in parallel
 *  4. finalize exact merged k6 summary once every shard is terminal
 */
export class K6RunWorkflow extends WorkflowEntrypoint<Env, K6RunWorkflowParams> {
	async run(event: WorkflowEvent<K6RunWorkflowParams>, step: WorkflowStep): Promise<WorkflowResult> {
		const runId = event.payload.runId;
		if (!runId) throw new Error("runId is required");

		const { shardIds } = await step.do("mark run starting", STATE_STEP, async () => {
			const result = await coordinator(this.env).markStarting(runId);
			return { runId: result.runId, shardIds: [...result.shardIds] };
		});

		let launchFailed = false;
		try {
			await Promise.all(
				shardIds.map((shardId: string) =>
					step.do(`launch shard ${shardId}`, LAUNCH_STEP, async (ctx) => {
						console.log(JSON.stringify({ msg: "launch shard", runId, shardId, attempt: ctx.attempt }));
						const result = await coordinator(this.env).launchShard(runId, shardId);
						return { shardId: result.shardId, status: result.status, error: result.error };
					}),
				),
			);
		} catch (error) {
			launchFailed = true;
			console.error(JSON.stringify({ msg: "launch fan-out failed", runId, error: String(error) }));
			await step.do("stop run after launch failure", STATE_STEP, async () => {
				const run = await coordinator(this.env).stopRun(runId);
				return { runId: run.id, status: run.status };
			});
		}

		if (!launchFailed) {
			const launched = await step.do("mark run launched", STATE_STEP, async () => {
				const run = await coordinator(this.env).markLaunched(runId);
				return { runId: run.id, status: run.status };
			});
			if (launched.status === "failed") return this.finalize(step, runId, "finalize failed launch");
		}

		for (let poll = 1; poll <= MAX_POLLS; poll++) {
			await step.sleep(`wait before poll ${poll}`, POLL_INTERVAL);
			let results: PollResult[];
			try {
				results = await Promise.all(
					shardIds.map((shardId: string) =>
						step.do(`collect shard ${shardId} poll ${poll}`, COLLECT_STEP, async (ctx) => {
							console.log(JSON.stringify({ msg: "collect shard", runId, shardId, poll, attempt: ctx.attempt }));
							const result = await coordinator(this.env).collectShard(runId, shardId);
							return { shardId: result.shardId, status: result.status, running: result.running, error: result.error };
						}),
					),
				) as PollResult[];
			} catch (error) {
				console.error(JSON.stringify({ msg: "collect fan-out failed", runId, poll, error: String(error) }));
				await step.do("stop run after collection failure", STATE_STEP, async () => {
					const run = await coordinator(this.env).stopRun(runId);
					return { runId: run.id, status: run.status };
				});
				return this.finalize(step, runId, "finalize failed collection");
			}

			if (results.every((result) => !result.running)) {
				return this.finalize(step, runId, "finalize run");
			}
		}

		await step.do("stop run after workflow timeout", STATE_STEP, async () => {
			const run = await coordinator(this.env).stopRun(runId);
			return { runId: run.id, status: run.status };
		});
		return this.finalize(step, runId, "finalize timed out run");
	}

	private async finalize(step: WorkflowStep, runId: string, name: string): Promise<WorkflowResult> {
		return step.do(name, FINALIZE_STEP, async () => {
			const run = await coordinator(this.env).finalizeRun(runId);
			return { runId: run.id, status: run.status };
		});
	}
}
