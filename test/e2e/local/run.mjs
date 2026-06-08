import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runPlatformE2E, stopProcess } from "../shared/platform-e2e.mjs";

const port = Number(process.env.E2E_PORT ?? 8789);
const baseUrl = `http://127.0.0.1:${port}`;
const auth = `Basic ${Buffer.from("test-user:test-pass", "utf8").toString("base64")}`;
const script = fileURLToPath(new URL("./target.k6.js", import.meta.url));

let dev;

try {
	dev = spawn("bunx", ["wrangler", "dev", "--config", "wrangler.e2e.jsonc", "--ip", "127.0.0.1", "--port", String(port)], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, NO_COLOR: "1" },
	});

	dev.stdout.on("data", (chunk) => process.stdout.write(`[wrangler] ${chunk}`));
	dev.stderr.on("data", (chunk) => process.stderr.write(`[wrangler] ${chunk}`));

	await runPlatformE2E({ baseUrl, auth, script, region: "ENAM", timeoutMs: 240_000, label: "local" });
} finally {
	if (dev) await stopProcess(dev);
}
