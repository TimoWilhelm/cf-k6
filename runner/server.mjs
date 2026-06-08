import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";

const PORT = Number(process.env.PORT || 8788);
const WORKDIR = "/tmp/k6-runner";
const K6_ADDRESS = "127.0.0.1:6565";
const RESULTS = `${WORKDIR}/results.ndjson`;

let child = null;
let current = null;

const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
		const { pathname } = url;

		if (req.method === "GET" && pathname === "/ready") return send(res, 200, { ok: true });
		if (req.method === "GET" && pathname === "/status") return send(res, 200, localStatus());
		if (req.method === "POST" && pathname === "/run") return runInline(req, res);
		if (req.method === "POST" && pathname === "/run-archive") return runArchive(req, res);
		if (req.method === "POST" && pathname === "/stop") return stop(res);
		if (pathname.startsWith("/v1/")) return proxyK6(req, res, pathname);
		if (req.method === "GET" && pathname === "/artifacts/results.ndjson") return sendFile(res, RESULTS, "application/x-ndjson");
		return send(res, 404, { error: "not found" });
	} catch (error) {
		return send(res, 500, { error: error instanceof Error ? error.message : "unknown error" });
	}
});

server.listen(PORT, "0.0.0.0", () => {
	console.log(JSON.stringify({ level: "info", msg: "runner listening", port: PORT }));
});

async function runInline(req, res) {
	if (child) return send(res, 409, { error: "k6 is already running" });
	const body = await readJson(req);
	const { runId, shardId, region, segment, sequence, source, options, env, args } = body;
	if (!runId || !shardId || !source) return send(res, 400, { error: "runId, shardId and source are required" });

	await mkdir(WORKDIR, { recursive: true });
	await writeFile(`${WORKDIR}/script.js`, source);
	await writeFile(`${WORKDIR}/options.json`, JSON.stringify(options ?? {}, null, 2));

	const k6Args = [
		...baseArgs({ runId, shardId, region, segment, sequence }),
		"--config",
		`${WORKDIR}/options.json`,
		...(Array.isArray(args) ? args : []),
		`${WORKDIR}/script.js`,
	];
	startK6(k6Args, env, { runId, shardId, region });
	return send(res, 202, localStatus());
}

async function runArchive(req, res) {
	if (child) return send(res, 409, { error: "k6 is already running" });
	const runId = req.headers["x-k6-run"];
	const shardId = req.headers["x-k6-shard"];
	if (!runId || !shardId) return send(res, 400, { error: "x-k6-run and x-k6-shard headers are required" });

	await mkdir(WORKDIR, { recursive: true });
	await pipeline(req, createWriteStream(`${WORKDIR}/archive.tar`));

	const env = parseHeaderJson(req.headers["x-k6-env"], {});
	const args = parseHeaderJson(req.headers["x-k6-args"], []);
	const k6Args = [
		...baseArgs({
			runId,
			shardId,
			region: req.headers["x-k6-region"],
			segment: req.headers["x-k6-segment"],
			sequence: req.headers["x-k6-sequence"],
		}),
		...(Array.isArray(args) ? args : []),
		`${WORKDIR}/archive.tar`,
	];
	startK6(k6Args, env, { runId, shardId, region: req.headers["x-k6-region"] });
	return send(res, 202, localStatus());
}

/** Platform-owned flags shared by inline and archive runs. */
function baseArgs({ runId, shardId, region, segment, sequence }) {
	const args = ["run", `--address=${K6_ADDRESS}`, "--out", `json=${RESULTS}`];
	if (segment) args.push("--execution-segment", segment);
	if (sequence) args.push("--execution-segment-sequence", sequence);
	args.push("--tag", `run_id=${runId}`, "--tag", `shard_id=${shardId}`);
	if (region) args.push("--tag", `region=${region}`);
	return args;
}

function startK6(args, env, meta) {
	current = { ...meta, args, startedAt: new Date().toISOString(), exitCode: null };
	child = spawn("k6", args, { env: { ...process.env, ...(env ?? {}) }, cwd: WORKDIR, stdio: ["ignore", "pipe", "pipe"] });
	child.stdout.on("data", (chunk) => console.log(JSON.stringify({ stream: "stdout", text: String(chunk) })));
	child.stderr.on("data", (chunk) => console.error(JSON.stringify({ stream: "stderr", text: String(chunk) })));
	child.on("exit", (code) => {
		if (current) current.exitCode = code;
		child = null;
	});
}

async function stop(res) {
	if (!child) return send(res, 200, localStatus());
	try {
		await fetch(`http://${K6_ADDRESS}/v1/status`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ data: { type: "status", id: "default", attributes: { stopped: true } } }),
		});
	} catch {
		child.kill("SIGTERM");
	}
	return send(res, 202, localStatus());
}

async function proxyK6(req, res, path) {
	const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readRaw(req);
	const upstream = await fetch(`http://${K6_ADDRESS}${path}`, {
		method: req.method,
		headers: { "content-type": req.headers["content-type"] || "application/json" },
		body,
	});
	res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
	res.end(Buffer.from(await upstream.arrayBuffer()));
}

function localStatus() {
	return { running: Boolean(child), current };
}

async function sendFile(res, path, contentType) {
	try {
		const data = await readFile(path);
		res.writeHead(200, { "content-type": contentType, "content-length": String(data.byteLength) });
		res.end(data);
	} catch {
		send(res, 404, { error: "artifact not found" });
	}
}

function send(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body, null, 2));
}

async function readJson(req) {
	const raw = await readRaw(req);
	return raw.length ? JSON.parse(raw.toString("utf8")) : {};
}

function readRaw(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function parseHeaderJson(value, fallback) {
	if (!value) return fallback;
	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}
