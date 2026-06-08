import { getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { consumeNdjson, mergeLiveMetrics, SummaryAccumulator, type MergedMetrics } from "./metrics";
import { runnerNamespace } from "./runners";
import { buildShards } from "./shards";
import type { RunRecord, RunStatus, Shard, ShardStatus, TestSpec } from "./types";

/** Native k6 `/v1/status` PATCH body (pause/resume/scale/stop). */
export type StatusPatch = {
	data?: { type?: string; id?: string; attributes?: { paused?: boolean; vus?: number; stopped?: boolean } };
};

export type ShardLaunchResult = { shardId: string; status: ShardStatus; error?: string };
export type ShardCollectionResult = { shardId: string; status: ShardStatus; running: boolean; error?: string };

const ACTIVE: RunStatus[] = ["starting", "running", "stopping"];

type Row = {
	id: string;
	status: RunStatus;
	created_at: string;
	updated_at: string;
	created_by: string;
	spec_json: string;
	shards_json: string;
};

/** k6 `/v1/status` JSON:API shape, aggregated across shards. */
export type AggregateStatus = {
	data: { type: "status"; id: "default"; attributes: { running: boolean; paused: boolean; tainted: boolean; vus: number } };
	meta: { shards: Array<{ id: string; region: string; status: string; reachable: boolean }> };
};

/**
 * Single coordinator instance (addressed by name "runs") that owns run state in
 * SQLite and exposes idempotent operations for the Workflow. Lifecycle timing,
 * fan-out, sleeps, retries, and finalization order are owned by K6RunWorkflow.
 */
export class RunCoordinator extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS runs (
					id TEXT PRIMARY KEY,
					status TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					created_by TEXT NOT NULL,
					spec_json TEXT NOT NULL,
					shards_json TEXT NOT NULL
				)
			`);
		});
	}

	async createRun(spec: TestSpec, createdBy: string): Promise<RunRecord> {
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const run: RunRecord = {
			id,
			status: "created",
			createdAt: now,
			updatedAt: now,
			createdBy,
			spec,
			shards: buildShards(id, spec),
		};
		this.save(run);
		await this.env.ARTIFACTS.put(`runs/${id}/spec.json`, JSON.stringify(spec, null, 2), {
			httpMetadata: { contentType: "application/json" },
		});
		return run;
	}

	async listRuns(): Promise<RunRecord[]> {
		return this.ctx.storage.sql
			.exec<Row>("SELECT * FROM runs ORDER BY created_at DESC LIMIT 100")
			.toArray()
			.map(rowToRun);
	}

	async getRun(id: string): Promise<RunRecord | null> {
		const rows = this.ctx.storage.sql.exec<Row>("SELECT * FROM runs WHERE id = ?", id).toArray();
		return rows.length ? rowToRun(rows[0]) : null;
	}

	/** First idempotent Workflow step: mark a run as entering the lifecycle. */
	async markStarting(id: string): Promise<{ runId: string; shardIds: string[] }> {
		const run = await this.require(id);
		if (run.status === "created" || run.status === "failed" || run.status === "completed") {
			run.status = "starting";
			for (const shard of run.shards) shard.status = "created";
			this.touch(run);
		}
		return { runId: run.id, shardIds: run.shards.map((shard) => shard.id) };
	}

	/** Fan-out Workflow step: launch exactly one shard. Safe to retry. */
	async launchShard(id: string, shardId: string): Promise<ShardLaunchResult> {
		const run = await this.require(id);
		const shard = this.requireShard(run, shardId);
		if (shard.status === "running" || shard.status === "completed") return { shardId, status: shard.status };

		await this.startContainer(run.spec, shard);
		await this.setShardStatus(id, shardId, "running");
		return { shardId, status: "running" };
	}

	/** Mark aggregate state after the Workflow launch fan-out finishes. */
	async markLaunched(id: string): Promise<RunRecord> {
		const run = await this.require(id);
		run.status = run.shards.every((shard) => shard.status === "failed") ? "failed" : "running";
		this.touch(run);
		return run;
	}

	async stopRun(id: string): Promise<RunRecord> {
		const run = await this.require(id);
		if (!ACTIVE.includes(run.status)) return run;

		run.status = "stopping";
		this.touch(run);
		await this.forEachRunning(run, (container) =>
			container.fetch(stopRequest()).then(() => undefined).catch(() => undefined),
		);
		return run;
	}

	/** Fan-out Workflow polling step: collect status/artifact for one shard. */
	async collectShard(id: string, shardId: string): Promise<ShardCollectionResult> {
		const run = await this.require(id);
		const shard = this.requireShard(run, shardId);
		if (shard.status !== "running") return { shardId, status: shard.status, running: false };

		const container = this.shardContainer(shard);
		const statusResponse = await container.fetch(k6Request("/status"));
		if (!statusResponse.ok) throw new Error(`runner status returned ${statusResponse.status}`);

		const status = (await statusResponse.json()) as {
			running?: boolean;
			current?: { exitCode?: number | null };
		};

		if (status.running) return { shardId, status: "running", running: true };

		const exitCode = status.current?.exitCode;
		const artifact = await container.fetch(k6Request("/artifacts/results.ndjson"));
		if (!artifact.ok || !artifact.body) {
			if (exitCode) {
				await this.setShardStatus(id, shardId, "failed");
				return { shardId, status: "failed", running: false, error: `k6 exited ${exitCode} without a results artifact` };
			}
			throw new Error(`results artifact returned ${artifact.status}`);
		}

		await putKnownLengthArtifact(this.env.ARTIFACTS, `runs/${run.id}/shards/${shard.id}/results.ndjson`, artifact, "application/x-ndjson");

		const finalStatus = exitCode ? "failed" : "completed";
		await this.setShardStatus(id, shardId, finalStatus);
		return { shardId, status: finalStatus, running: false };
	}

	/** Final Workflow step: write the exact merged k6 summary and terminal status. */
	async finalizeRun(id: string): Promise<RunRecord> {
		const run = await this.require(id);
		const accumulator = new SummaryAccumulator();

		for (const shard of run.shards) {
			const object = await this.env.ARTIFACTS.get(`runs/${run.id}/shards/${shard.id}/results.ndjson`);
			if (object) await consumeNdjson(object.body, accumulator);
		}

		await this.env.ARTIFACTS.put(`runs/${run.id}/summary.json`, JSON.stringify(accumulator.toSummaryExport(), null, 2), {
			httpMetadata: { contentType: "application/json" },
		});

		run.status = run.shards.every((shard) => shard.status === "completed") ? "completed" : "failed";
		this.touch(run);
		return run;
	}

	/** Aggregated, k6-native `/v1/status` across all shards. */
	async getStatus(id: string): Promise<AggregateStatus> {
		const run = await this.require(id);
		const shards = await Promise.all(
			run.shards.map(async (shard) => {
				try {
					const response = await this.shardContainer(shard).fetch(k6Request("/v1/status"));
					const body = (await response.json()) as { data?: { attributes?: Record<string, unknown> } };
					return { shard, attrs: body.data?.attributes ?? {}, reachable: response.ok };
				} catch {
					return { shard, attrs: {} as Record<string, unknown>, reachable: false };
				}
			}),
		);

		const reachable = shards.filter((s) => s.reachable);
		return {
			data: {
				type: "status",
				id: "default",
				attributes: {
					running: reachable.some((s) => s.attrs.running === true),
					paused: reachable.length > 0 && reachable.every((s) => s.attrs.paused === true),
					tainted: reachable.some((s) => s.attrs.tainted === true),
					vus: reachable.reduce((total, s) => total + (Number(s.attrs.vus) || 0), 0),
				},
			},
			meta: {
				shards: shards.map((s) => ({ id: s.shard.id, region: s.shard.region, status: s.shard.status, reachable: s.reachable })),
			},
		};
	}

	/** Aggregated, k6-native `/v1/metrics` across all shards. */
	async getMetrics(id: string): Promise<MergedMetrics> {
		const run = await this.require(id);
		const responses = await Promise.all(
			run.shards.map(async (shard) => {
				try {
					const response = await this.shardContainer(shard).fetch(k6Request("/v1/metrics"));
					return response.ok ? await response.json() : null;
				} catch {
					return null;
				}
			}),
		);
		return mergeLiveMetrics(responses.filter((value) => value !== null));
	}

	/** Forward a PATCH /v1/status (pause/resume/scale/stop) to every shard. */
	async patchStatus(id: string, body: StatusPatch): Promise<AggregateStatus> {
		const run = await this.require(id);
		await this.forEachRunning(run, (container) =>
			container
				.fetch(k6Request("/v1/status", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))
				.then(() => undefined)
				.catch(() => undefined),
		);
		return this.getStatus(id);
	}

	/** Proxy a request straight through to one shard's native k6 REST API. */
	async proxyShard(id: string, shardId: string, path: string, method: string, body: ArrayBuffer | null): Promise<Response> {
		const run = await this.require(id);
		const shard = run.shards.find((candidate) => candidate.id === shardId);
		if (!shard) return Response.json({ error: "unknown shard" }, { status: 404 });
		const init: RequestInit = { method };
		if (body && body.byteLength > 0) {
			init.body = body;
			init.headers = { "content-type": "application/json" };
		}
		return this.shardContainer(shard).fetch(k6Request(`/v1/${path}`, init));
	}

	private async startContainer(spec: TestSpec, shard: Shard): Promise<void> {
		const container = this.shardContainer(shard);
		if (spec.script.type === "inline") {
			const response = await container.fetch(
				k6Request("/run", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						runId: shard.runId,
						shardId: shard.id,
						region: shard.region,
						segment: shard.segment,
						sequence: shard.sequence,
						source: spec.script.source,
						options: spec.options,
						env: spec.env,
						args: spec.args,
					}),
				}),
			);
			await assertStarted(container, response);
			return;
		}

		const archive = await this.env.ARTIFACTS.get(`runs/${shard.runId}/archive.tar`);
		if (!archive) throw new Error("archive not found in R2");
		const body = await archive.arrayBuffer();
		const response = await container.fetch(
			k6Request("/run-archive", {
				method: "POST",
				headers: {
					"content-type": "application/x-tar",
					"content-length": String(body.byteLength),
					"x-k6-run": shard.runId,
					"x-k6-shard": shard.id,
					"x-k6-region": shard.region,
					"x-k6-segment": shard.segment,
					"x-k6-sequence": shard.sequence,
					"x-k6-env": JSON.stringify(spec.env ?? {}),
					"x-k6-args": JSON.stringify(spec.args ?? []),
				},
				body,
			}),
		);
		await assertStarted(container, response);
	}

	private shardContainer(shard: Shard) {
		return getContainer(runnerNamespace(this.env, shard.region), shard.containerName);
	}

	private async forEachRunning(run: RunRecord, fn: (container: ReturnType<RunCoordinator["shardContainer"]>) => Promise<void>): Promise<void> {
		await Promise.all(run.shards.filter((shard) => shard.status === "running").map((shard) => fn(this.shardContainer(shard))));
	}

	private async require(id: string): Promise<RunRecord> {
		const run = await this.getRun(id);
		if (!run) throw new RunNotFound(id);
		return run;
	}

	private requireShard(run: RunRecord, shardId: string): Shard {
		const shard = run.shards.find((candidate) => candidate.id === shardId);
		if (!shard) throw new Error(`unknown shard: ${shardId}`);
		return shard;
	}

	private async setShardStatus(id: string, shardId: string, status: ShardStatus): Promise<RunRecord> {
		const run = await this.require(id);
		this.requireShard(run, shardId).status = status;
		this.touch(run);
		return run;
	}

	private touch(run: RunRecord): void {
		run.updatedAt = new Date().toISOString();
		this.save(run);
	}

	private save(run: RunRecord): void {
		this.ctx.storage.sql.exec(
			`INSERT OR REPLACE INTO runs (id, status, created_at, updated_at, created_by, spec_json, shards_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			run.id,
			run.status,
			run.createdAt,
			run.updatedAt,
			run.createdBy,
			JSON.stringify(run.spec),
			JSON.stringify(run.shards),
		);
	}
}

export class RunNotFound extends Error {
	constructor(id: string) {
		super(`run not found: ${id}`);
	}
}

async function assertStarted(container: Fetcher, response: Response): Promise<void> {
	if (response.ok) return;
	if (response.status === 409) {
		const status = (await container.fetch(k6Request("/status")).then((r) => r.json()).catch(() => null)) as { running?: boolean } | null;
		if (status?.running) return;
	}
	throw new Error(`runner returned ${response.status}: ${await response.text().catch(() => "<unreadable>")}`);
}

function rowToRun(row: Row): RunRecord {
	return {
		id: row.id,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		createdBy: row.created_by,
		spec: JSON.parse(row.spec_json) as TestSpec,
		shards: JSON.parse(row.shards_json) as Shard[],
	};
}

function k6Request(path: string, init?: RequestInit): Request {
	return new Request(`https://runner.local${path}`, init);
}

function stopRequest(): Request {
	return k6Request("/v1/status", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ data: { type: "status", id: "default", attributes: { stopped: true } } }),
	});
}

async function putKnownLengthArtifact(bucket: R2Bucket, key: string, response: Response, contentType: string): Promise<void> {
	if (!response.body) throw new Error(`artifact ${key} has no body`);
	const contentLength = Number(response.headers.get("content-length"));
	if (!Number.isFinite(contentLength) || contentLength < 0) {
		throw new Error(`artifact ${key} is missing a valid content-length`);
	}

	const fixed = new FixedLengthStream(contentLength);
	await Promise.all([
		response.body.pipeTo(fixed.writable),
		bucket.put(key, fixed.readable, { httpMetadata: { contentType } }),
	]);
}
