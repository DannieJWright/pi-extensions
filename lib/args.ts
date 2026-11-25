import { validateToolArguments } from "@earendil-works/pi-ai";

// Decodes JSON text that a model sent where a tool schema declares an array or object. Pure, synchronous, never throws.
// Not handled: nested anyOf branches and $ref (no schema in this repository uses them); only top-level anyOf is read.
type Schema = Record<string, any>;
const MAX_TEXT = 8192, MAX_DEPTH = 8;
const wrappers = new WeakMap<Schema, Schema>();

/** Short single-line preview of a value for error text. */
export function preview(value: unknown, max = 60): string {
	const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One-property wrapper, built once per property schema so Pi's own validator cache is reused too. */
export function wrapperSchema(property: Schema): Schema {
	let wrapper = wrappers.get(property);
	if (!wrapper) wrappers.set(property, wrapper = { type: "object", properties: { value: property }, required: ["value"] });
	return wrapper;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isEncodable = (schema: Schema) => schema.type === "array" || schema.type === "object";

// Validity is decided by Pi's own validator (with coercion) for this property only; failure leaves the value alone.
function accepted(property: Schema, value: unknown): { value: unknown } | undefined {
	try {
		return { value: validateToolArguments({ name: "value", parameters: wrapperSchema(property) } as any, { name: "value", arguments: { value } } as any).value };
	} catch { return undefined; }
}

function walk(schemas: Schema[], value: unknown, depth: number): unknown {
	if (depth > MAX_DEPTH) return value;
	if (typeof value === "string") {
		const text = value.trim();
		// Only bracketed text up to 8 KiB is parsed, and only where the schema declares array or object (never string).
		if (value.length > MAX_TEXT || !(text.startsWith("[") || text.startsWith("{"))) return value;
		let decoded: unknown;
		try { decoded = JSON.parse(text); } catch { return value; }
		for (const schema of schemas.filter(isEncodable)) {
			// Decode nested text first: validation would otherwise coerce it into a one-item list.
			const result = accepted(schema, walk([schema], decoded, depth + 1));
			if (result) return result.value;
		}
		return value;
	}
	if (Array.isArray(value)) {
		// Recurse through items so nested arrays such as required_checks are handled; copy only when an item changed.
		const items = schemas.filter((schema) => schema.type === "array" && isObject(schema.items)).map((schema) => schema.items as Schema);
		if (!items.length) return value;
		const next = value.map((item) => walk(items, item, depth + 1));
		return next.some((item, index) => item !== value[index]) ? next : value;
	}
	if (!isObject(value)) return value;
	let copy: Record<string, unknown> | undefined;
	for (const key of Object.keys(value)) {
		const properties = schemas.filter((schema) => isObject(schema.properties?.[key])).map((schema) => schema.properties[key] as Schema);
		if (!properties.length) continue;
		const next = walk(properties, value[key], depth + 1);
		if (next !== value[key]) (copy ??= { ...value })[key] = next;
	}
	return copy ?? value;
}

/** Returns args with JSON-encoded array/object properties decoded, or the same args when nothing applies. */
export function normalizeJsonEncoded(schema: unknown, args: unknown): unknown {
	try {
		if (!isObject(args) || !isObject(schema)) return args;
		const branches: Schema[] = Array.isArray(schema.anyOf) ? schema.anyOf.filter(isObject) : [schema];
		// Pick the anyOf branch whose action const equals args.action; with no match use every branch's properties.
		const matched = branches.filter((branch) => branch.properties?.action?.const === args.action);
		return walk(matched.length ? matched : branches, args, 0);
	} catch { return args; }
}
