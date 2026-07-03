import { check, sleep } from "k6";
import http from "k6/http";

export const options = {
	cloud: {
		distribution: {
			ENAM: { loadZone: "ENAM", percent: 100 },
		},
		shardsPerRegion: 3,
	},
	vus: 2,
	duration: "5s",
	insecureSkipTLSVerify: true,
	thresholds: {
		http_req_failed: ["rate<0.01"],
		checks: ["rate==1"],
	},
};

export default function () {
	const response = http.get(__ENV.TARGET_URL || "https://example.com");
	check(response, {
		"status is 200": (res) => res.status === 200,
	});
	sleep(1);
}
