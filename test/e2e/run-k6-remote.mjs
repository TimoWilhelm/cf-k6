import { readDotEnv, runPlatformE2E } from "./platform-e2e.mjs";

const env = { ...process.env, ...await readDotEnv(".env") };
const baseUrl = env.REMOTE_BASE_URL ?? "https://container-loadtester.tiwicf.workers.dev";
const region = env.REMOTE_TEST_REGION ?? "ENAM";
const username = env.BASIC_AUTH_USER;
const password = env.BASIC_AUTH_PASS;

if (!username || !password) {
	throw new Error("BASIC_AUTH_USER and BASIC_AUTH_PASS are required in .env or process.env");
}

const auth = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
await runPlatformE2E({
	baseUrl,
	auth,
	region,
	timeoutMs: Number(env.REMOTE_TEST_TIMEOUT_MS ?? 600_000),
	label: "remote",
});
