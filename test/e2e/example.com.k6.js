import { check, sleep } from "k6";
import http from "k6/http";

export const options = {
	vus: 3,
	duration: "10s",
	insecureSkipTLSVerify: true,
	thresholds: {
		http_req_failed: ["rate<0.01"],
		checks: ["rate==1"],
	},
};

// A tiny but real load pattern: VUs loop for a short duration and each shard
// owns a k6 execution segment. Defaults are intentionally low for CI/e2e.
export default function () {
	const response = http.get(__ENV.TARGET_URL || "https://example.com");
	check(response, {
		"status is 200": (res) => res.status === 200,
	});
	sleep(1);
}
