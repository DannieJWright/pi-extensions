// Merge rules for permission-mode.src.jsonc. Pure: no fs, no pi imports, so tests can import it.

export type JsonObject = Record<string, unknown>;

export class MergeError extends Error {}

const RESERVED = new Set(["extends", "$replace"]);

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep merge `source` into `target`.
 * - Inherited keys keep their position; new keys are appended at the end.
 * - `$replace` in an object replaces the inherited object fully.
 * - Arrays replace. `key+` appends to the inherited array (deduplicated).
 * - `null` deletes the inherited key. A type change replaces.
 */
function mergeInto(target: JsonObject, source: JsonObject): JsonObject {
	for (const [key, value] of Object.entries(source)) {
		if (RESERVED.has(key)) continue;

		if (key.endsWith("+")) {
			const base = key.slice(0, -1);
			if (Array.isArray(value)) {
				const merged = Array.isArray(target[base]) ? [...(target[base] as unknown[])] : [];
				for (const item of value) {
					if (!merged.includes(item)) merged.push(item);
				}
				target[base] = merged;
			} else {
				target[base] = value;
			}
			continue;
		}

		if (value === null) {
			delete target[key];
			continue;
		}

		if (isObject(value)) {
			// Merge into a fresh object when there is nothing to inherit, so `key+` and null still apply.
			const base = value.$replace === true || !isObject(target[key]) ? {} : (target[key] as JsonObject);
			target[key] = mergeInto(base, value);
			continue;
		}

		target[key] = value;
	}

	return target;
}

/** Resolve one entry (fragment or mode) against the source, left to right. */
function resolveEntry(
	name: string,
	body: JsonObject,
	fragments: JsonObject,
	modes: JsonObject,
	stack: Set<string>,
): JsonObject {
	if (stack.has(name)) {
		throw new MergeError(`extends cycle: ${[...stack].join(" -> ")} -> ${name}`);
	}
	const next = new Set(stack);
	next.add(name);

	let result: JsonObject = {};
	const list = body.extends;
	if (list !== undefined) {
		if (!Array.isArray(list)) {
			throw new MergeError(`"${name}": extends must be a list of fragment or mode names`);
		}
		for (const ref of list) {
			const entry = fragments[ref] ?? modes[ref];
			if (!isObject(entry)) {
				const known = [...Object.keys(fragments), ...Object.keys(modes)].join(", ") || "none";
				throw new MergeError(`"${name}": unknown extends "${ref}" (known: ${known})`);
			}
			result = mergeInto(result, resolveEntry(ref, entry, fragments, modes, next));
		}
	}

	return mergeInto(result, body);
}

/** Build the plain JSON config: source.output plus resolved modes. */
export function buildConfig(source: JsonObject): JsonObject {
	const fragments = isObject(source.fragments) ? source.fragments : {};
	const modes = isObject(source.modes) ? source.modes : {};

	const config: JsonObject = {};
	for (const [key, value] of Object.entries(source)) {
		if (key === "fragments" || key === "modes") continue;
		// The output block is the file header: its contents go at the top level.
		if (key === "output" && isObject(value)) {
			for (const [innerKey, innerValue] of Object.entries(value)) config[innerKey] = innerValue;
			continue;
		}
		config[key] = value;
	}

	const resolved: JsonObject = {};
	for (const [name, body] of Object.entries(modes)) {
		if (!isObject(body)) {
			throw new MergeError(`mode "${name}" must be an object`);
		}
		resolved[name] = resolveEntry(name, body, fragments, modes, new Set<string>());
	}

	config.modes = resolved;
	return config;
}
