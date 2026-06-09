import { fileURLToPath } from "node:url";
import { readDotEnv, runPlatformE2E } from "../shared/platform-e2e.mjs";

const env = { ...process.env, ...await readDotEnv(".env") };
const baseUrl = env.REMOTE_BASE_URL;
const region = env.REMOTE_TEST_REGION ?? "ENAM";
const username = env.BASIC_AUTH_USER;
const password = env.BASIC_AUTH_PASS;
const script = fileURLToPath(new URL("./target.k6.js", import.meta.url));

if (!username || !password) {
	throw new Error("BASIC_AUTH_USER and BASIC_AUTH_PASS are required in .env or process.env");
}
if (!baseUrl) {
	throw new Error("REMOTE_BASE_URL is required for remote e2e tests");
}

const auth = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
await runPlatformE2E({
	baseUrl,
	auth,
	script,
	region,
	timeoutMs: Number(env.REMOTE_TEST_TIMEOUT_MS ?? 600_000),
	label: "remote",
});
