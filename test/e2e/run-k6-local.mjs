import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const port = Number(process.env.E2E_PORT ?? 8789);
const baseUrl = `http://127.0.0.1:${port}`;
const auth = `Basic ${Buffer.from("test-user:test-pass", "utf8").toString("base64")}`;
const workdir = await mkdtemp(join(tmpdir(), "container-loadtester-e2e-"));
const script = resolve("test/e2e/example.com.k6.js");
const archive = join(workdir, "archive.tar");

let dev;

try {
	await assertK6Available();
	await runRequired("k6", ["archive", script, "-O", archive]);

	dev = spawn("bunx", ["wrangler", "dev", "--config", "wrangler.e2e.jsonc", "--ip", "127.0.0.1", "--port", String(port)], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, NO_COLOR: "1" },
	});

	dev.stdout.on("data", (chunk) => process.stdout.write(`[wrangler] ${chunk}`));
	dev.stderr.on("data", (chunk) => process.stderr.write(`[wrangler] ${chunk}`));

	await waitForApi();

	const createResponse = await fetch(`${baseUrl}/v1/tests?regions=ENAM&shardsPerRegion=3`, {
		method: "POST",
		headers: { authorization: auth, "content-type": "application/x-tar" },
		body: await readFile(archive),
	});
	await assertResponse(createResponse, 201, "create run");

	const run = await createResponse.json();
	assert(run.shards?.length === 3, `expected 3 shards, got ${run.shards?.length}`);
	assert(run.shards.every((shard) => shard.region === "ENAM"), "expected all e2e shards to target ENAM");

	const startResponse = await fetch(`${baseUrl}/v1/tests/${run.id}/start`, { method: "POST", headers: { authorization: auth } });
	await assertResponse(startResponse, 200, "start run");

	const completed = await waitForRun(run.id);

	let totalRequests = 0;
	let totalFailedRequests = 0;
	const artifactStatuses = [];
	for (const shard of completed.shards) {
		const resultsResponse = await fetch(`${baseUrl}/v1/tests/${run.id}/shards/${shard.id}/results`, { headers: { authorization: auth } });
		artifactStatuses.push({ shard: shard.id, shardStatus: shard.status, artifactStatus: resultsResponse.status });
		assert(resultsResponse.ok, `missing results artifact for ${shard.id}: ${resultsResponse.status}; run=${completed.status}; details=${JSON.stringify(artifactStatuses)}`);
		const ndjson = await resultsResponse.text();
		totalRequests += countMetricPoints(ndjson, "http_reqs");
		totalFailedRequests += countMetricPoints(ndjson, "http_req_failed");
	}

	assert(completed.status === "completed", `expected run to complete, got ${completed.status}; details=${JSON.stringify(artifactStatuses)}; totalRequests=${totalRequests}`);
	assert(completed.shards.every((shard) => shard.status === "completed"), `expected all shards to complete; details=${JSON.stringify(artifactStatuses)}`);
	assert(totalRequests === 3, `expected 3 total http_reqs across container shards, got ${totalRequests}`);
	assert(totalFailedRequests === 0, `expected 0 failed requests across container shards, got ${totalFailedRequests}`);

	console.log("k6 e2e passed: canonical k6 archive ran through 3 Cloudflare Container shards against https://example.com");
} finally {
	if (dev) await stopProcess(dev);
	await rm(workdir, { recursive: true, force: true });
}

async function assertK6Available() {
	await runRequired("k6", ["version"], "k6 CLI is required for this e2e test. Install it locally, then run npm run test:e2e.");
}

async function waitForApi() {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${baseUrl}/v1/health`, { headers: { authorization: auth } });
			if (response.ok) return;
		} catch {
			// wait for wrangler dev startup
		}
		await sleep(1_000);
	}
	throw new Error("timed out waiting for wrangler dev API");
}

async function waitForRun(runId) {
	const deadline = Date.now() + 240_000;
	let last;
	while (Date.now() < deadline) {
		const response = await fetch(`${baseUrl}/v1/tests/${runId}`, { headers: { authorization: auth } });
		await assertResponse(response, 200, "get run");
		last = await response.json();
		if (last.status === "completed" || last.status === "failed") return last;
		await sleep(3_000);
	}
	throw new Error(`timed out waiting for run ${runId}; last status ${last?.status}`);
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

async function stopProcess(child) {
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
