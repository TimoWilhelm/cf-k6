import { getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import { readArchiveMetadata } from "./archive";
import { archiveSpecFromOptions } from "./distribution";
import { consumeNdjson, mergeLiveMetrics, SummaryAccumulator, type MergedMetrics } from "./metrics";
import { runnerNamespace } from "./runners";
import { buildShards } from "./shards";
import { evaluateThresholds, type SummaryExport, type SummaryShard, type ThresholdEvaluation } from "./thresholds";
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

type CloudLoadTestRow = {
	id: number;
	project_id: number;
	name: string;
	created_at: string;
	updated_at: string;
};

type CloudTestRunRow = {
	test_run_id: number;
	load_test_id: number;
	run_id: string;
	project_id: number;
	created_at: string;
	started_at: string;
	updated_at: string;
	estimated_seconds: number;
	result: string | null;
	thresholds_json: string;
};

type StatusEvent = { type: string; entered: string; extra?: { by_user?: string; message?: string; code?: number } };

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
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS cloud_load_tests (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					project_id INTEGER NOT NULL,
					name TEXT NOT NULL,
					created_at TEXT NOT NULL,
					updated_at TEXT NOT NULL
				)
			`);
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS cloud_test_runs (
					test_run_id INTEGER PRIMARY KEY AUTOINCREMENT,
					load_test_id INTEGER NOT NULL,
					run_id TEXT NOT NULL,
					project_id INTEGER NOT NULL,
					created_at TEXT NOT NULL,
					started_at TEXT NOT NULL,
					updated_at TEXT NOT NULL,
					estimated_seconds INTEGER NOT NULL,
					result TEXT,
					thresholds_json TEXT NOT NULL
				)
			`);
		});
	}

	fetch(request: Request): Response | Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/api/v1/tail") return Response.json({ error: "not found" }, { status: 404 });
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return Response.json({ error: "websocket upgrade required" }, { status: 426 });
		}
		const testRunId = testRunIdFromLogQuery(url.searchParams.get("query"));
		if (!testRunId) return Response.json({ error: "missing test_run_id query" }, { status: 400 });

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
		this.ctx.acceptWebSocket(server, [`test_run:${testRunId}`]);
		return new Response(null, { status: 101, webSocket: client });
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

	async createCloudLoadTest(projectId: number, name: string, archive: ArrayBuffer): Promise<Record<string, unknown>> {
		const now = new Date().toISOString();
		this.ctx.storage.sql.exec(
			"INSERT INTO cloud_load_tests (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
			projectId || 1,
			name,
			now,
			now,
		);
		const row = this.ctx.storage.sql.exec<CloudLoadTestRow>("SELECT * FROM cloud_load_tests ORDER BY id DESC LIMIT 1").one();
		await this.env.ARTIFACTS.put(`cloud/load-tests/${row.id}/archive.tar`, archive, {
			httpMetadata: { contentType: "application/x-tar" },
		});
		return loadTestModel(row);
	}

	async updateCloudLoadTestScript(loadTestId: number, archive: ArrayBuffer): Promise<void> {
		const row = this.cloudLoadTest(loadTestId);
		const now = new Date().toISOString();
		await this.env.ARTIFACTS.put(`cloud/load-tests/${row.id}/archive.tar`, archive, {
			httpMetadata: { contentType: "application/x-tar" },
		});
		this.ctx.storage.sql.exec("UPDATE cloud_load_tests SET updated_at = ? WHERE id = ?", now, row.id);
	}

	async startCloudTestRun(loadTestId: number, requestUrl: string): Promise<Record<string, unknown>> {
		const loadTest = this.cloudLoadTest(loadTestId);
		const archive = await this.env.ARTIFACTS.get(`cloud/load-tests/${loadTest.id}/archive.tar`);
		if (!archive) throw new Error("cloud load test archive not found");
		const archiveBytes = await archive.arrayBuffer();
		const metadata = readArchiveMetadata(archiveBytes);
		const spec = archiveSpecFromOptions(metadata.options, metadata.env);
		const run = await this.createRun(spec, "cloud");
		await this.env.ARTIFACTS.put(`runs/${run.id}/archive.tar`, archiveBytes, { httpMetadata: { contentType: "application/x-tar" } });

		const now = new Date().toISOString();
		this.ctx.storage.sql.exec(
			`INSERT INTO cloud_test_runs
			 (load_test_id, run_id, project_id, created_at, started_at, updated_at, estimated_seconds, result, thresholds_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			loadTest.id,
			run.id,
			loadTest.project_id,
			now,
			now,
			now,
			estimatedSeconds(metadata.options),
			null,
			JSON.stringify(metadata.options?.thresholds ?? {}),
		);
		const cloudRun = this.ctx.storage.sql.exec<CloudTestRunRow>("SELECT * FROM cloud_test_runs ORDER BY test_run_id DESC LIMIT 1").one();
		await startWorkflow(this.env, run.id);
		return this.cloudTestRunModel(cloudRun, run, requestUrl, true);
	}

	async getCloudTestRun(testRunId: number, requestUrl: string): Promise<Record<string, unknown>> {
		const cloudRun = this.cloudTestRun(testRunId);
		const run = await this.require(cloudRun.run_id);
		return this.cloudTestRunModel(cloudRun, run, requestUrl, false);
	}

	async abortCloudTestRun(testRunId: number): Promise<void> {
		const cloudRun = this.cloudTestRun(testRunId);
		await this.stopRun(cloudRun.run_id);
		const now = new Date().toISOString();
		this.ctx.storage.sql.exec("UPDATE cloud_test_runs SET updated_at = ?, result = COALESCE(result, 'error') WHERE test_run_id = ?", now, testRunId);
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
		await this.cleanupShards(run.shards);
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
				await this.cleanupShard(shard);
				return { shardId, status: "failed", running: false, error: `k6 exited ${exitCode} without a results artifact` };
			}
			throw new Error(`results artifact returned ${artifact.status}`);
		}

		await putKnownLengthArtifact(this.env.ARTIFACTS, `runs/${run.id}/shards/${shard.id}/results.ndjson`, artifact, "application/x-ndjson");

		const finalStatus = exitCode ? "failed" : "completed";
		await this.setShardStatus(id, shardId, finalStatus);
		await this.cleanupShard(shard);
		return { shardId, status: finalStatus, running: false };
	}

	/** Final Workflow step: write the exact merged k6 summary and terminal status. */
	async finalizeRun(id: string): Promise<RunRecord> {
		const run = await this.require(id);
		const accumulator = new SummaryAccumulator();
		const shards: SummaryShard[] = [];

		for (const shard of run.shards) {
			const key = `runs/${run.id}/shards/${shard.id}/results.ndjson`;
			const object = await this.env.ARTIFACTS.get(key);
			const records = object ? await consumeNdjson(object.body, accumulator) : 0;
			shards.push({
				id: shard.id,
				region: shard.region,
				index: shard.index,
				total: shard.total,
				status: shard.status,
				segment: shard.segment,
				sequence: shard.sequence,
				included: object !== null,
				records,
				links: { results: `/v1/tests/${run.id}/shards/${shard.id}/results` },
				...(object ? { artifact: { key, size: object.size, uploaded: object.uploaded.toISOString() } } : {}),
			});
		}

		const summary: SummaryExport = { ...accumulator.toSummaryExport(), shards };
		await this.env.ARTIFACTS.put(`runs/${run.id}/summary.json`, JSON.stringify(summary, null, 2), {
			httpMetadata: { contentType: "application/json" },
		});

		const cloudRun = this.findCloudRunByRunId(run.id);
		let evaluation: ThresholdEvaluation | null = null;
		if (cloudRun) {
			evaluation = evaluateThresholds(run.spec.options, summary);
			this.broadcastCloudLogs(cloudRun.test_run_id, renderSummaryText(summary, evaluation));
		}

		run.status = run.shards.every((shard) => shard.status === "completed") ? "completed" : "failed";
		this.touch(run);
		if (cloudRun) {
			const result = run.status === "completed" ? (evaluation?.passed === false ? "failed" : "passed") : "error";
			this.ctx.storage.sql.exec(
				"UPDATE cloud_test_runs SET updated_at = ?, result = ? WHERE test_run_id = ?",
				run.updatedAt,
				result,
				cloudRun.test_run_id,
			);
		}
		await this.cleanupShards(run.shards);
		return run;
	}

	/** Aggregated, k6-native `/v1/status` across all shards. */
	async getStatus(id: string): Promise<AggregateStatus> {
		const run = await this.require(id);
		const shards = await Promise.all(
			run.shards.map(async (shard) => {
				if (shard.status !== "running") return { shard, attrs: {} as Record<string, unknown>, reachable: false };
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
			run.shards.filter((shard) => shard.status === "running").map(async (shard) => {
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
		if (body.data?.attributes?.stopped === true) {
			await this.stopRun(id);
			return this.getStatus(id);
		}

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
		if (shard.status !== "running") return Response.json({ error: "shard is not running" }, { status: 409 });
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

	private async cleanupShards(shards: Shard[]): Promise<void> {
		await Promise.all(shards.map((shard) => this.cleanupShard(shard)));
	}

	private async cleanupShard(shard: Shard): Promise<void> {
		const container = this.shardContainer(shard);
		try {
			await container.destroy();
		} catch (error) {
			console.warn(JSON.stringify({ msg: "container destroy failed", runId: shard.runId, shardId: shard.id, error: String(error) }));
			await container.fetch(stopRequest()).then(() => undefined).catch(() => undefined);
		}
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

	private cloudLoadTest(id: number): CloudLoadTestRow {
		const rows = this.ctx.storage.sql.exec<CloudLoadTestRow>("SELECT * FROM cloud_load_tests WHERE id = ?", id).toArray();
		if (!rows.length) throw new Error(`cloud load test not found: ${id}`);
		return rows[0];
	}

	private cloudTestRun(id: number): CloudTestRunRow {
		const rows = this.ctx.storage.sql.exec<CloudTestRunRow>("SELECT * FROM cloud_test_runs WHERE test_run_id = ?", id).toArray();
		if (!rows.length) throw new Error(`cloud test run not found: ${id}`);
		return rows[0];
	}

	private findCloudRunByRunId(runId: string): CloudTestRunRow | null {
		const rows = this.ctx.storage.sql.exec<CloudTestRunRow>("SELECT * FROM cloud_test_runs WHERE run_id = ?", runId).toArray();
		return rows[0] ?? null;
	}

	private cloudTestRunModel(cloudRun: CloudTestRunRow, run: RunRecord, requestUrl: string, includeDetailsUrl: boolean): Record<string, unknown> {
		const status = cloudStatus(run.status);
		const history = statusHistory(cloudRun, run);
		const model: Record<string, unknown> = {
			id: cloudRun.test_run_id,
			test_run_id: cloudRun.test_run_id,
			test_id: cloudRun.load_test_id,
			project_id: cloudRun.project_id,
			started_by: null,
			created: cloudRun.created_at,
			ended: status === "completed" || status === "aborted" ? run.updatedAt : null,
			note: "",
			retention_expiry: null,
			cost: null,
			status,
			status_details: history[history.length - 1] ?? { type: status, entered: cloudRun.updated_at },
			status_history: history,
			distribution: [],
			result: cloudRun.result ?? (status === "completed" ? (run.status === "failed" ? "error" : "passed") : ""),
			result_details: {},
			options: run.spec.options ?? {},
			k6_dependencies: {},
			k6_versions: {},
			max_vus: maxVus(run.spec.options),
			max_browser_vus: 0,
			estimated_duration: cloudRun.estimated_seconds,
			execution_duration: executionSeconds(cloudRun.started_at, run.updatedAt, run.status === "running" || run.status === "starting"),
		};
		if (includeDetailsUrl) model.test_run_details_page_url = summaryUrl(requestUrl, run.id);
		return model;
	}

	private broadcastCloudLogs(testRunId: number, lines: string[]): void {
		for (const ws of this.ctx.getWebSockets(`test_run:${testRunId}`)) {
			for (const line of lines) ws.send(logFrame(line));
		}
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

function loadTestModel(row: CloudLoadTestRow): Record<string, unknown> {
	return { id: row.id, project_id: row.project_id, name: row.name, baseline_test_run_id: null, created: row.created_at, updated: row.updated_at };
}

function cloudStatus(status: RunStatus): string {
	switch (status) {
		case "created": return "created";
		case "starting": return "initializing";
		case "running": return "running";
		case "stopping": return "aborted";
		case "completed":
		case "failed": return "completed";
	}
}

function statusHistory(cloudRun: CloudTestRunRow, run: RunRecord): StatusEvent[] {
	const history: StatusEvent[] = [{ type: "created", entered: cloudRun.created_at }, { type: "running", entered: cloudRun.started_at }];
	if (run.status === "completed" || run.status === "failed") history.push({ type: "completed", entered: run.updatedAt });
	if (run.status === "stopping") history.push({ type: "aborted", entered: run.updatedAt, extra: { by_user: "cloud-cli" } });
	return history;
}

function executionSeconds(startedAt: string, updatedAt: string, live: boolean): number {
	const start = Date.parse(startedAt);
	if (!Number.isFinite(start)) return 0;
	const end = live ? Date.now() : Date.parse(updatedAt);
	return Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 1000)) : 0;
}

function estimatedSeconds(options: unknown): number {
	const opts = (options ?? {}) as Record<string, any>;
	if (typeof opts.duration === "string") return parseK6Duration(opts.duration);
	if (Array.isArray(opts.stages)) return sumDurations(opts.stages.map((stage: any) => stage?.duration));
	if (opts.scenarios && typeof opts.scenarios === "object") {
		let max = 0;
		for (const scenario of Object.values(opts.scenarios) as Array<Record<string, any>>) {
			let total = parseK6Duration(String(scenario.startTime ?? "0s"));
			if (typeof scenario.duration === "string") total += parseK6Duration(scenario.duration);
			else if (Array.isArray(scenario.stages)) total += sumDurations(scenario.stages.map((stage: any) => stage?.duration));
			max = Math.max(max, total);
		}
		if (max > 0) return max;
	}
	return 0;
}

function maxVus(options: unknown): number {
	const opts = (options ?? {}) as Record<string, any>;
	if (typeof opts.vus === "number") return opts.vus;
	if (opts.scenarios && typeof opts.scenarios === "object") {
		let max = 0;
		for (const scenario of Object.values(opts.scenarios) as Array<Record<string, any>>) {
			if (typeof scenario.vus === "number") max = Math.max(max, scenario.vus);
			if (Array.isArray(scenario.stages)) {
				for (const stage of scenario.stages as Array<Record<string, any>>) if (typeof stage.target === "number") max = Math.max(max, stage.target);
			}
		}
		return max;
	}
	if (Array.isArray(opts.stages)) return Math.max(0, ...opts.stages.map((stage: any) => Number(stage?.target) || 0));
	return 0;
}

function sumDurations(values: unknown[]): number {
	return values.reduce<number>((total, value) => total + (typeof value === "string" ? parseK6Duration(value) : 0), 0);
}

function parseK6Duration(value: string): number {
	let total = 0;
	const unitSeconds: Record<string, number> = { ns: 1e-9, us: 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600 };
	for (const match of value.matchAll(/(\d+(?:\.\d+)?)(ns|us|ms|s|m|h)/g)) total += Number(match[1]) * unitSeconds[match[2]];
	return Math.ceil(total);
}

function renderSummaryText(summary: SummaryExport, evaluation: ThresholdEvaluation): string[] {
	const lines = ["", "aggregated k6 summary (all remote shards)", "========================================"];
	if (summary.shards?.length) {
		lines.push("", "shards");
		for (const shard of summary.shards) {
			const artifact = shard.included ? `${shard.records} records` : "missing results";
			lines.push(`${shard.id} ${shard.region} ${shard.segment} ${shard.status} ${artifact} ${shard.links.results}`);
		}
	}
	for (const [name, stats] of Object.entries(summary.metrics).sort(([a], [b]) => a.localeCompare(b))) {
		lines.push(`${name}: ${Object.entries(stats).map(([key, value]) => `${key}=${formatMetric(value)}`).join(" ")}`);
	}
	if (Object.keys(evaluation.results).length > 0) {
		lines.push("", "thresholds");
		for (const [metric, results] of Object.entries(evaluation.results)) {
			for (const [expression, passed] of Object.entries(results)) lines.push(`${passed ? "PASS" : "FAIL"} ${metric} ${expression}`);
		}
	}
	return lines;
}

function formatMetric(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function logFrame(line: string): string {
	return JSON.stringify({ streams: [{ stream: { level: "info" }, values: [[String(Date.now() * 1_000_000), line]] }] });
}

function testRunIdFromLogQuery(query: string | null): number | null {
	const match = query?.match(/test_run_id\s*=\s*"?(\d+)"?/);
	return match ? Number(match[1]) : null;
}

function summaryUrl(requestUrl: string, runId: string): string {
	const url = new URL(requestUrl);
	return `${url.origin}/v1/tests/${runId}/summary`;
}

async function startWorkflow(env: Env, runId: string): Promise<void> {
	try {
		await env.K6_RUN_WORKFLOW.create({ id: runId, params: { runId } });
	} catch {
		await env.K6_RUN_WORKFLOW.get(runId);
	}
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
