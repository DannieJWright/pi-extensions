// Reject JSON numbers that JSON.parse/JSON.stringify would change, including in nested values.
export class JsonRoundtripError extends Error {}

function decimalParts(text: string): string {
	const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text)!;
	let digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/, "");
	if (!digits) return "0";
	let exponent = BigInt(match[4] ?? "0") - BigInt((match[3] ?? "").length);
	const trailing = /0+$/.exec(digits)?.[0].length ?? 0;
	if (trailing) { digits = digits.slice(0, -trailing); exponent += BigInt(trailing); }
	return `${match[1]}${digits}e${exponent}`;
}

/** Parse JSON/JSONC after comment removal, rejecting numbers that cannot round-trip. */
export function parseRoundtripJson(text: string, file: string): unknown {
	return JSON.parse(text, (key, value, context: { source?: string }) => {
		if (typeof value === "number") {
			const raw = context.source;
			if (raw === undefined || Object.is(value, -0) || !Number.isFinite(value) || decimalParts(raw) !== decimalParts(JSON.stringify(value))) {
				throw new JsonRoundtripError(`${file}: number ${raw ?? String(value)} at key ${JSON.stringify(key)} cannot be preserved by JSON serialization; edit it before generating`);
			}
		}
		return value;
	});
}

/** Guard generated objects at the serialization boundary as well. */
export function assertRoundtripValues(value: unknown, where: string): void {
	if (typeof value === "number" && (Object.is(value, -0) || !Number.isFinite(value))) {
		throw new JsonRoundtripError(`${where}: number ${Object.is(value, -0) ? "-0" : String(value)} cannot be preserved by JSON serialization`);
	}
	if (Array.isArray(value)) value.forEach((child, i) => assertRoundtripValues(child, `${where}[${i}]`));
	else if (value !== null && typeof value === "object") for (const [key, child] of Object.entries(value)) assertRoundtripValues(child, `${where}.${key}`);
}
