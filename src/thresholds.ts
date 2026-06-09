import type { K6Options } from "./types";

export type SummaryShard = {
	id: string;
	region: string;
	index: number;
	total: number;
	status: string;
	segment: string;
	sequence: string;
	included: boolean;
	records: number;
	links: { results: string };
	artifact?: { key: string; size: number; uploaded: string };
};

export type SummaryExport = { metrics: Record<string, Record<string, number>>; shards?: SummaryShard[] };

export type ThresholdEvaluation = {
	passed: boolean;
	results: Record<string, Record<string, boolean>>;
	failures: string[];
};

const THRESHOLD = /^\s*([A-Za-z0-9_().]+)\s*(<=|>=|<|>|==|===)\s*(-?(?:\d+\.?\d*|\d*\.\d+))\s*$/;

export function evaluateThresholds(options: K6Options | undefined, summary: SummaryExport): ThresholdEvaluation {
	const thresholds = (options?.thresholds ?? {}) as Record<string, unknown>;
	const results: ThresholdEvaluation["results"] = {};
	const failures: string[] = [];

	for (const [metricName, expressions] of Object.entries(thresholds)) {
		const metric = summary.metrics[metricName];
		results[metricName] = {};
		const list = Array.isArray(expressions) ? expressions : [];
		for (const candidate of list) {
			const expression = thresholdExpression(candidate);
			if (!expression) continue;
			const ok = evaluateExpression(expression, metric ?? {});
			results[metricName][expression] = ok;
			if (!ok) failures.push(`${metricName}: ${expression}`);
		}
	}

	return { passed: failures.length === 0, results, failures };
}

function thresholdExpression(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && typeof (value as { threshold?: unknown }).threshold === "string") {
		return (value as { threshold: string }).threshold;
	}
	return null;
}

function evaluateExpression(expression: string, metric: Record<string, number>): boolean {
	const match = expression.match(THRESHOLD);
	if (!match) return false;
	const [, stat, operator, rawExpected] = match;
	const actual = metric[stat];
	const expected = Number(rawExpected);
	if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
	switch (operator) {
		case "<": return actual < expected;
		case "<=": return actual <= expected;
		case ">": return actual > expected;
		case ">=": return actual >= expected;
		case "==":
		case "===": return actual === expected;
		default: return false;
	}
}
