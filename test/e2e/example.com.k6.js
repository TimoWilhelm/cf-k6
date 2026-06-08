import { check } from "k6";
import http from "k6/http";

export const options = {
	vus: 1,
	iterations: 1,
	insecureSkipTLSVerify: true,
};

// This e2e validates that every platform shard spins up its own container and
// runs real k6 code. k6 execution segments may allocate zero default-function
// iterations to non-leading segments for tiny tests, but setup() runs once per
// k6 process, so every container shard makes one canonical HTTP request.
export function setup() {
	const response = http.get("https://example.com");
	check(response, {
		"status is 200": (res) => res.status === 200,
	});
}

export default function () {}
