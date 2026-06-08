import type { K6Options } from "./types";

export type ArchiveMetadata = {
	options?: K6Options;
	env?: Record<string, string>;
};

/** Read `metadata.json` from a k6 archive tar without introducing a tar dependency. */
export function readArchiveMetadata(bytes: ArrayBuffer): ArchiveMetadata {
	const data = new Uint8Array(bytes);
	let offset = 0;
	while (offset + 512 <= data.byteLength) {
		const header = data.subarray(offset, offset + 512);
		if (isEmptyBlock(header)) break;
		const name = readString(header.subarray(0, 100));
		const prefix = readString(header.subarray(345, 500));
		const path = prefix ? `${prefix}/${name}` : name;
		const size = parseOctal(readString(header.subarray(124, 136)));
		const bodyOffset = offset + 512;
		if (path === "metadata.json" || path.endsWith("/metadata.json")) {
			const raw = new TextDecoder().decode(data.subarray(bodyOffset, bodyOffset + size));
			return JSON.parse(raw) as ArchiveMetadata;
		}
		offset = bodyOffset + Math.ceil(size / 512) * 512;
	}
	throw new Error("k6 archive metadata.json not found");
}

function isEmptyBlock(block: Uint8Array): boolean {
	for (const byte of block) if (byte !== 0) return false;
	return true;
}

function readString(bytes: Uint8Array): string {
	let end = 0;
	while (end < bytes.length && bytes[end] !== 0) end++;
	return new TextDecoder().decode(bytes.subarray(0, end)).trim();
}

function parseOctal(value: string): number {
	const parsed = Number.parseInt(value.trim() || "0", 8);
	return Number.isFinite(parsed) ? parsed : 0;
}
