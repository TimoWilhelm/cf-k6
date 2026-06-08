import { spawn } from "node:child_process";
import { readDotEnv } from "./platform-e2e.mjs";

const env = { ...process.env, ...await readDotEnv(".env") };
const baseUrl = trimTrailingSlash(env.REMOTE_BASE_URL ?? "https://container-loadtester.tiwicf.workers.dev");
const script = env.K6_CLOUD_TEST_SCRIPT ?? "test/e2e/cloud-no-load.k6.js";
const username = env.BASIC_AUTH_USER;
const password = env.BASIC_AUTH_PASS;

if (!username || !password) {
	throw new Error("BASIC_AUTH_USER and BASIC_AUTH_PASS are required in .env or process.env");
}

await assertK6Available();

const url = new URL(baseUrl);
const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
const logsTailUrl = `${wsProtocol}//${url.host}/api/v1/tail`;

console.log(`k6 cloud target.......: ${baseUrl}`);
console.log(`k6 cloud logs.........: ${logsTailUrl}`);
console.log(`k6 script.............: ${script}`);
console.log("k6 auth...............: K6_CLOUD_TOKEN from .env BASIC_AUTH_USER/BASIC_AUTH_PASS");

await runK6Cloud(script, {
	...process.env,
	K6_CLOUD_TOKEN: `${username}:${password}`,
	K6_CLOUD_STACK_ID: env.K6_CLOUD_STACK_ID ?? "1",
	K6_CLOUD_PROJECT_ID: env.K6_CLOUD_PROJECT_ID ?? "1",
	K6_CLOUD_HOST_V6: baseUrl,
	K6_CLOUD_LOGS_TAIL_URL: logsTailUrl,
	K6_CLOUD_WEB_APP_URL: baseUrl,
	NO_COLOR: env.NO_COLOR ?? "1",
});

function runK6Cloud(testScript, childEnv) {
	return new Promise((resolve, reject) => {
		const child = spawn("k6", ["cloud", "run", "--show-logs", testScript], {
			stdio: "inherit",
			env: childEnv,
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`k6 cloud run exited with status ${code}`));
		});
	});
}

async function assertK6Available() {
	await new Promise((resolve, reject) => {
		const child = spawn("k6", ["version"], { stdio: "ignore" });
		child.on("error", () => reject(new Error("k6 CLI is required for this script")));
		child.on("close", (code) => code === 0 ? resolve() : reject(new Error("k6 CLI is required for this script")));
	});
}

function trimTrailingSlash(value) {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}
