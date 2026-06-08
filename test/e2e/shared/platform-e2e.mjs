import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const SHARDS = 3;
const MIN_EXPECTED_REQUESTS = 15;

export async function runPlatformE2E({ baseUrl, auth, script, region = "ENAM", timeoutMs = 600_000, label = "e2e" }) {
	const workdir = await mkdtemp(join(tmpdir(), "container-loadtester-e2e-"));
	const resolvedScript = resolve(script);
	const archive = join(workdir, "archive.tar");

	try {
		await assertK6Available();
		await runRequired("k6", ["archive", resolvedScript, "-O", archive]);
		await waitForApi(baseUrl, auth);

		const createResponse = await fetch(`${baseUrl}/v1/tests?regions=${encodeURIComponent(region)}&shardsPerRegion=${SHARDS}`, {
			method: "POST",
			headers: { authorization: auth, "content-type": "application/x-tar" },
			body: await readFile(archive),
		});
		await assertResponse(createResponse, 201, "create run");

		const run = await createResponse.json();
		assert(run.shards?.length === SHARDS, `expected exactly ${SHARDS} shards, got ${run.shards?.length}`);
		assert(run.shards.every((shard) => shard.region === region), `expected all shards to target ${region}`);

		console.log(`${label}: created run ${run.id}`);
		console.log(`${label}: shards ${run.shards.map((shard) => `${shard.id}[${shard.segment}]`).join(", ")}`);

		const startResponse = await fetch(`${baseUrl}/v1/tests/${run.id}/start`, { method: "POST", headers: { authorization: auth } });
		await assertResponse(startResponse, 200, "start run");

		const completed = await waitForRun(baseUrl, auth, run.id, timeoutMs, label);
		const summary = await getJson(`${baseUrl}/v1/tests/${run.id}/summary`, auth, "summary");
		const shardStats = await getShardStats(baseUrl, auth, completed);

		printSummary({ label, baseUrl, region, run: completed, summary, shardStats });

		const totalRequests = shardStats.reduce((total, shard) => total + shard.http_reqs, 0);
		const totalFailedRequests = shardStats.reduce((total, shard) => total + shard.http_req_failed, 0);

		assert(completed.status === "completed", `expected run to complete, got ${completed.status}; totalRequests=${totalRequests}`);
		assert(completed.shards.length === SHARDS, `expected exactly ${SHARDS} completed shards, got ${completed.shards.length}`);
		assert(completed.shards.every((shard) => shard.status === "completed"), `expected all shards to complete; details=${JSON.stringify(completed.shards)}`);
		assert(shardStats.every((shard) => shard.http_reqs > 0), `expected every shard to generate requests; details=${JSON.stringify(shardStats)}`);
		assert(totalRequests >= MIN_EXPECTED_REQUESTS, `expected at least ${MIN_EXPECTED_REQUESTS} total http_reqs across container shards, got ${totalRequests}`);
		assert(totalFailedRequests === 0, `expected 0 failed requests across container shards, got ${totalFailedRequests}`);
		assert(metric(summary, "http_req_failed", "rate") <= 0.01, "http_req_failed threshold failed");
		assert(metric(summary, "checks", "rate") === 1, "checks threshold failed");

		return { run: completed, summary, shardStats };
	} finally {
		await rm(workdir, { recursive: true, force: true });
	}
}

export async function readDotEnv(path) {
	try {
		const contents = await readFile(path, "utf8");
		const result = {};
		for (const line of contents.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
			if (!match) continue;
			let value = match[2].trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
			result[match[1]] = value;
		}
		return result;
	} catch {
		return {};
	}
}

export async function stopProcess(child) {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	await new Promise((resolve) => {
		const timeout = setTimeout(resolve, 5_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolve();
		});
	});
	if (child.exitCode === null) child.kill("SIGKILL");
}

async function assertK6Available() {
	await runRequired("k6", ["version"], "k6 CLI is required for this e2e test.");
}

async function waitForApi(baseUrl, auth) {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${baseUrl}/v1/health`, { headers: { authorization: auth } });
			if (response.ok) return;
		} catch {
			// wait for API startup or route propagation
		}
		await sleep(1_000);
	}
	throw new Error(`timed out waiting for API at ${baseUrl}`);
}

async function waitForRun(baseUrl, auth, runId, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	let last;
	let lastLog = 0;
	while (Date.now() < deadline) {
		const response = await fetch(`${baseUrl}/v1/tests/${runId}`, { headers: { authorization: auth } });
		await assertResponse(response, 200, "get run");
		last = await response.json();

		if (Date.now() - lastLog > 10_000 || last.status === "completed" || last.status === "failed") {
			const shardSummary = last.shards.map((shard) => `${shard.id}:${shard.status}`).join(" ");
			console.log(`${label}: status=${last.status} ${shardSummary}`);
			lastLog = Date.now();
		}

		if (last.status === "completed" || last.status === "failed") return last;
		await sleep(5_000);
	}
	throw new Error(`timed out waiting for run ${runId}; last status ${last?.status}`);
}

async function getShardStats(baseUrl, auth, run) {
	const stats = [];
	for (const shard of run.shards) {
		const response = await fetch(`${baseUrl}/v1/tests/${run.id}/shards/${shard.id}/results`, { headers: { authorization: auth } });
		await assertResponse(response, 200, `get results for ${shard.id}`);
		const ndjson = await response.text();
		stats.push({
			id: shard.id,
			region: shard.region,
			status: shard.status,
			http_reqs: countMetricPoints(ndjson, "http_reqs"),
			http_req_failed: countMetricPoints(ndjson, "http_req_failed"),
			checks: countMetricPoints(ndjson, "checks"),
		});
	}
	return stats;
}

function printSummary({ label, baseUrl, region, run, summary, shardStats }) {
	const metrics = summary.metrics ?? {};
	console.log(`\n=== ${label} k6 platform load result ===`);
	console.log(`run_id................: ${run.id}`);
	console.log(`status................: ${run.status}`);
	console.log(`api...................: ${baseUrl}`);
	console.log(`distribution..........: ${region} x ${SHARDS} shards`);
	console.log(`script_vus............: 3`);
	console.log(`script_duration.......: 10s`);
	console.log(`http_reqs.............: ${format(metrics.http_reqs?.count)} (${format(metrics.http_reqs?.rate)}/s)`);
	console.log(`http_req_failed.......: ${formatPercent(metrics.http_req_failed?.rate)} (${format(metrics.http_req_failed?.passes)} failed)`);
	console.log(`checks................: ${formatPercent(metrics.checks?.rate)} (${format(metrics.checks?.passes)} passed / ${format(metrics.checks?.fails)} failed)`);
	console.log(`http_req_duration avg.: ${format(metrics.http_req_duration?.avg)} ms`);
	console.log(`http_req_duration p95.: ${format(metrics.http_req_duration?.["p(95)"])} ms`);
	console.log("\nper-shard results:");
	for (const shard of shardStats) {
		console.log(`  ${shard.id.padEnd(8)} ${shard.region} ${shard.status.padEnd(10)} http_reqs=${shard.http_reqs} failed=${shard.http_req_failed} checks=${shard.checks}`);
	}
	console.log("");
}

function countMetricPoints(ndjson, metricName) {
	let count = 0;
	for (const line of ndjson.split("\n")) {
		if (!line.trim()) continue;
		const event = JSON.parse(line);
		if (event.type === "Point" && event.metric === metricName) count += Number(event.data?.value ?? 0);
	}
	return count;
}

function metric(summary, name, key) {
	return Number(summary.metrics?.[name]?.[key] ?? 0);
}

async function getJson(url, auth, label) {
	const response = await fetch(url, { headers: { authorization: auth } });
	await assertResponse(response, 200, `get ${label}`);
	return response.json();
}

function runRequired(command, args, message) {
	return run(command, args).then((result) => {
		if (result.code !== 0) throw new Error(message ?? `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
		return result;
	});
}

function run(command, args) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => resolveRun({ code, stdout, stderr }));
	});
}

function format(value) {
	return typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value) : "-";
}

function formatPercent(value) {
	return typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 2 }).format(value) : "-";
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function assertResponse(response, expectedStatus, label) {
	if (response.status === expectedStatus) return;
	throw new Error(`${label} failed: ${response.status} ${await response.text()}`);
}
