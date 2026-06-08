import { check, sleep } from "k6";

export const options = {
	cloud: {
		distribution: {
			ENAM: { loadZone: "ENAM", percent: 100 },
		},
		shardsPerRegion: 3,
	},
	vus: 1,
	duration: "3s",
	thresholds: {
		checks: ["rate==1"],
	},
};

export default function () {
	check(true, { "local check passes": (value) => value === true });
	sleep(1);
}
