// Section-local inheritance and merge rules. Pure: no fs, no pi imports.

export type JsonObject = Record<string, unknown>;

export class MergeError extends Error {}

const RESERVED = new Set(["extends", "$replace"]);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject names that can change or expose an object's prototype, including append keys. */
function validateKeys(value: unknown, path: string): void {
	if (Array.isArray(value)) {
		value.forEach((item, index) => validateKeys(item, `${path}[${index}]`));
	} else if (isObject(value)) {
		for (const [key, child] of Object.entries(value)) {
			const base = key.replace(/\++$/, "");
			if (UNSAFE_KEYS.has(base)) throw new MergeError(`${path}.${key}: unsafe property name; rename this key`);
			validateKeys(child, `${path}.${key}`);
		}
	}
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
				const inherited = Object.hasOwn(target, base) ? target[base] : undefined;
				const merged = Array.isArray(inherited) ? [...inherited] : [];
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
			const inherited = Object.hasOwn(target, key) ? target[key] : undefined;
			const replace = Object.hasOwn(value, "$replace") && value.$replace === true;
			const base = replace || !isObject(inherited) ? {} : inherited;
			target[key] = mergeInto(base, value);
			continue;
		}

		target[key] = value;
	}

	return target;
}

/** Resolve an entry only against the fragments and entries of its own section. */
function resolveEntry(
	body: JsonObject,
	entryPath: string,
	section: string,
	entryKind: string,
	fragments: JsonObject,
	entries: JsonObject,
	stack: Set<string>,
): JsonObject {
	if (stack.has(entryPath)) {
		throw new MergeError(`${entryPath}: extends cycle: ${[...stack].join(" -> ")} -> ${entryPath}`);
	}
	const next = new Set(stack);
	next.add(entryPath);

	let result: JsonObject = {};
	const list = Object.hasOwn(body, "extends") ? body.extends : undefined;
	if (list !== undefined) {
		if (!Array.isArray(list)) {
			throw new MergeError(`${entryPath}: extends must be a list of fragment or ${entryKind} names`);
		}
		for (const ref of list) {
			const inFragments = typeof ref === "string" && Object.hasOwn(fragments, ref);
			const inEntries = typeof ref === "string" && Object.hasOwn(entries, ref);
			const entry = inFragments ? fragments[ref] : inEntries ? entries[ref] : undefined;
			if (!isObject(entry)) {
				const known = [...Object.keys(fragments), ...Object.keys(entries)].join(", ") || "none";
				throw new MergeError(`${entryPath}: unknown extends "${ref}" (known: ${known})`);
			}
			const refPath = `${section}.${inFragments ? "fragments" : entryKind}.${ref}`;
			result = mergeInto(result, resolveEntry(entry, refPath, section, entryKind, fragments, entries, next));
		}
	}

	return mergeInto(result, body);
}

function resolveEntries(source: JsonObject, section: string, entryKind: string): JsonObject {
	const fragments = Object.hasOwn(source, "fragments") && isObject(source.fragments) ? source.fragments : {};
	const entries = Object.hasOwn(source, entryKind) && isObject(source[entryKind]) ? source[entryKind] : {};
	const resolved: JsonObject = {};
	for (const [name, body] of Object.entries(entries)) {
		const entryPath = `${section}.${entryKind}.${name}`;
		if (!isObject(body)) throw new MergeError(`${entryPath}: must be an object`);
		resolved[name] = resolveEntry(body, entryPath, section, entryKind, fragments, entries, new Set<string>());
	}
	return resolved;
}

/** Build the plain JSON config: source.output plus resolved modes. */
export function buildConfig(source: JsonObject): JsonObject {
	validateKeys(source, "permissionModes");
	const config: JsonObject = {};
	for (const [key, value] of Object.entries(source)) {
		if (key === "fragments" || key === "modes") continue;
		if (key === "output" && isObject(value)) {
			for (const [innerKey, innerValue] of Object.entries(value)) config[innerKey] = innerValue;
			continue;
		}
		config[key] = value;
	}
	config.modes = resolveEntries(source, "permissionModes", "modes");
	return config;
}

/** Build settings without inventing agentOverrides when agents is absent. */
export function buildSubagents(source: JsonObject): JsonObject {
	validateKeys(source, "subagents");
	const settings = Object.hasOwn(source, "settings") && isObject(source.settings) ? source.settings : {};
	if (Object.hasOwn(settings, "agentOverrides")) {
		throw new MergeError("subagents.settings.agentOverrides: use subagents.agents instead");
	}
	const result: JsonObject = { ...settings };
	if (Object.hasOwn(source, "agents")) {
		if (!isObject(source.agents)) {
			throw new MergeError("subagents.agents: must be an object mapping agent names to overrides");
		}
		result.agentOverrides = resolveEntries(source, "subagents", "agents");
	}
	return result;
}
