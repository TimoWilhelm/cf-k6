/**
 * k6 metric aggregation.
 *
 * Two paths, matching the two fidelities available in a distributed run:
 *
 *  - `mergeLiveMetrics` merges each shard's native `/v1/metrics` snapshot while
 *    the test runs. Counters and gauges merge exactly; trend percentiles and
 *    rates cannot be merged exactly from per-shard summaries, so they are
 *    reported as approximations (flagged in `meta`).
 *
 *  - `SummaryAccumulator` consumes the raw `--out json` sample stream from every
 *    shard and recomputes exact aggregate statistics, identical to what a single
 *    k6 instance would report. It emits k6's native summary-export JSON.
 */

type MetricType = "counter" | "gauge" | "rate" | "trend";

type Sample = Record<string, number>;

type LiveMetric = {
	type: MetricType;
	contains: string;
	id: string;
	samples: Sample[];
};

/** Aggregated k6 `/v1/metrics` payload (JSON:API shape) returned over RPC. */
export type MergedMetrics = {
	data: Array<{
		type: "metrics";
		id: string;
		attributes: { type: MetricType; contains: string; tainted: null; sample: Sample };
	}>;
	meta: { shards: number; approximate: string[] };
};

const DEFAULT_TREND_STATS = ["avg", "min", "med", "max", "p(90)", "p(95)"] as const;

/** Merge native k6 `/v1/metrics` responses from every shard into one. */
export function mergeLiveMetrics(shardResponses: unknown[]): MergedMetrics {
	const metrics = new Map<string, LiveMetric>();

	for (const response of shardResponses) {
		const data = (response as { data?: unknown })?.data;
		if (!Array.isArray(data)) continue;
		for (const entry of data) {
			const id = str(entry?.id);
			const attrs = entry?.attributes;
			if (!id || !attrs || typeof attrs !== "object") continue;
			const type = attrs.type as MetricType;
			const sample = attrs.sample;
			if (!isMetricType(type) || !sample || typeof sample !== "object") continue;

			let metric = metrics.get(id);
			if (!metric) {
				metric = { id, type, contains: str(attrs.contains) ?? "default", samples: [] };
				metrics.set(id, metric);
			}
			metric.samples.push(sample as Sample);
		}
	}

	const approximate = new Set<string>();
	const data: MergedMetrics["data"] = [...metrics.values()].map((metric) => ({
		type: "metrics",
		id: metric.id,
		attributes: {
			type: metric.type,
			contains: metric.contains,
			tainted: null,
			sample: mergeSample(metric, approximate),
		},
	}));

	return { data, meta: { shards: shardResponses.length, approximate: [...approximate] } };
}

function mergeSample(metric: LiveMetric, approximate: Set<string>): Sample {
	switch (metric.type) {
		case "counter":
			return {
				count: sum(metric.samples.map((s) => s.count)),
				rate: sum(metric.samples.map((s) => s.rate)),
			};
		case "gauge":
			// Gauges are concurrency-like (vus); summing across shards is the
			// meaningful aggregate for a distributed run.
			return { value: sum(metric.samples.map((s) => s.value)) };
		case "rate": {
			approximate.add(metric.id);
			return { rate: mean(metric.samples.map((s) => s.rate)) };
		}
		case "trend": {
			approximate.add(metric.id);
			const merged: Sample = {
				min: Math.min(...metric.samples.map((s) => s.min ?? Infinity)),
				max: Math.max(...metric.samples.map((s) => s.max ?? -Infinity)),
			};
			for (const stat of DEFAULT_TREND_STATS) {
				if (stat === "min" || stat === "max") continue;
				merged[stat] = mean(metric.samples.map((s) => s[stat]));
			}
			return merged;
		}
	}
}

/**
 * Accumulates raw k6 JSON-output samples (one NDJSON object per line) from all
 * shards and computes exact aggregate statistics for the end-of-test summary.
 */
export class SummaryAccumulator {
	private types = new Map<string, MetricType>();
	private contains = new Map<string, string>();
	private trends = new Map<string, number[]>();
	private counters = new Map<string, number>();
	private gauges = new Map<string, { last: number; min: number; max: number; time: number }>();
	private rates = new Map<string, { passes: number; total: number }>();
	private minTime = Infinity;
	private maxTime = -Infinity;

	/** Feed a single parsed NDJSON line from a k6 JSON output stream. */
	addLine(line: string): void {
		if (!line) return;
		let obj: { type?: string; metric?: string; data?: Record<string, unknown> };
		try {
			obj = JSON.parse(line);
		} catch {
			return; // ignore malformed/partial lines
		}
		const name = obj.metric;
		if (!name || !obj.data) return;

		if (obj.type === "Metric") {
			const type = obj.data.type;
			if (isMetricType(type)) this.types.set(name, type);
			if (typeof obj.data.contains === "string") this.contains.set(name, obj.data.contains);
			return;
		}
		if (obj.type !== "Point") return;

		const value = Number(obj.data.value);
		if (!Number.isFinite(value)) return;
		const time = Date.parse(String(obj.data.time));
		if (Number.isFinite(time)) {
			this.minTime = Math.min(this.minTime, time);
			this.maxTime = Math.max(this.maxTime, time);
		}

		switch (this.types.get(name)) {
			case "trend":
				push(this.trends, name, value);
				break;
			case "counter":
				this.counters.set(name, (this.counters.get(name) ?? 0) + value);
				break;
			case "rate": {
				const r = this.rates.get(name) ?? { passes: 0, total: 0 };
				r.total += 1;
				if (value !== 0) r.passes += 1;
				this.rates.set(name, r);
				break;
			}
			case "gauge": {
				const g = this.gauges.get(name);
				if (!g || time >= g.time) {
					this.gauges.set(name, {
						last: value,
						min: g ? Math.min(g.min, value) : value,
						max: g ? Math.max(g.max, value) : value,
						time: Number.isFinite(time) ? time : 0,
					});
				} else {
					g.min = Math.min(g.min, value);
					g.max = Math.max(g.max, value);
				}
				break;
			}
		}
	}

	/** Produce k6's native summary-export JSON (`{ metrics: { ... } }`). */
	toSummaryExport(): { metrics: Record<string, Sample> } {
		const elapsedSeconds = this.maxTime > this.minTime ? (this.maxTime - this.minTime) / 1000 : 0;
		const metrics: Record<string, Sample> = {};

		for (const [name, count] of this.counters) {
			metrics[name] = { count, rate: elapsedSeconds > 0 ? count / elapsedSeconds : 0 };
		}
		for (const [name, g] of this.gauges) {
			metrics[name] = { value: g.last, min: g.min, max: g.max };
		}
		for (const [name, r] of this.rates) {
			metrics[name] = {
				rate: r.total > 0 ? r.passes / r.total : 0,
				passes: r.passes,
				fails: r.total - r.passes,
			};
		}
		for (const [name, values] of this.trends) {
			values.sort((a, b) => a - b);
			metrics[name] = {
				avg: mean(values),
				min: values[0] ?? 0,
				med: percentile(values, 50),
				max: values[values.length - 1] ?? 0,
				"p(90)": percentile(values, 90),
				"p(95)": percentile(values, 95),
			};
		}

		return { metrics };
	}
}

/** Parse an R2/NDJSON byte stream line by line, feeding each into `accumulator`. */
export async function consumeNdjson(stream: ReadableStream<Uint8Array>, accumulator: SummaryAccumulator): Promise<void> {
	const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
	let buffer = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += value;
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			accumulator.addLine(buffer.slice(0, newline).trim());
			buffer = buffer.slice(newline + 1);
		}
	}
	accumulator.addLine(buffer.trim());
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	if (sorted.length === 1) return sorted[0];
	const rank = (p / 100) * (sorted.length - 1);
	const low = Math.floor(rank);
	const high = Math.ceil(rank);
	if (low === high) return sorted[low];
	return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

function isMetricType(value: unknown): value is MetricType {
	return value === "counter" || value === "gauge" || value === "rate" || value === "trend";
}

function push(map: Map<string, number[]>, key: string, value: number): void {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}

function sum(values: Array<number | undefined>): number {
	let total = 0;
	for (const value of values) if (typeof value === "number" && Number.isFinite(value)) total += value;
	return total;
}

function mean(values: Array<number | undefined>): number {
	const real = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
	return real.length ? sum(real) / real.length : 0;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
