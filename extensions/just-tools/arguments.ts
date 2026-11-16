import type { Recipe, RecipeParameter } from "./recipes.ts";

interface PropertySchema {
	type: string;
	description: string;
	items?: { type: "string" };
	minItems?: number;
	maxItems?: number;
	minimum?: number;
	maximum?: number;
	multipleOf?: number;
	properties?: Record<string, PropertySchema>;
	additionalProperties?: false;
}

export interface ArgumentSchema {
	type: "object";
	properties: Record<string, PropertySchema>;
	required: string[];
	additionalProperties: false;
	anyOf?: Array<Record<string, unknown>>;
}

/** Pick a stable name without reserving any valid recipe parameter. */
export function optionsName(recipe: Recipe): string {
	const names = new Set(recipe.parameters.map((param) => param.name));
	let name = "just_options";
	while (names.has(name)) name = `_${name}`;
	return name;
}

function option(param: RecipeParameter): string | undefined {
	if (param.long !== null && param.long !== undefined) {
		if (typeof param.long !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(param.long)) throw new Error(`Unsupported long option for ${param.name}`);
		return `--${param.long}`;
	}
	if (param.short !== null && param.short !== undefined) {
		if (typeof param.short !== "string" || !/^[A-Za-z0-9]$/.test(param.short)) throw new Error(`Unsupported short option for ${param.name}`);
		return `-${param.short}`;
	}
	return undefined;
}

function required(param: RecipeParameter): boolean {
	if (param.flag) return false;
	if (param.kind === "star") return false;
	if (param.kind === "plus") return true;
	return param.default === null;
}

export function schemaFor(recipe: Recipe): ArgumentSchema {
	const properties: Record<string, PropertySchema> = Object.create(null);
	const requiredNames: string[] = [];
	let sawVariadic = false;
	for (const param of recipe.parameters) {
		if (!param.name || Object.hasOwn(properties, param.name)) throw new Error(`Invalid or duplicate parameter in ${recipe.path}`);
		const opt = option(param);
		if (param.default === undefined || typeof param.multiple !== "boolean" ||
			(param.value !== null && typeof param.value !== "string") ||
			(param.flag && !opt) || (param.flag && param.value !== null) ||
			(param.multiple && (!opt || param.flag || param.value !== null)) ||
			(param.kind !== "singular" && (opt || param.multiple)) ||
			(sawVariadic && !opt)) {
			throw new Error(`Unsupported parameter shape for ${recipe.path}.${param.name}`);
		}
		if (param.kind !== "singular") sawVariadic = true;
		const isArray = param.kind !== "singular" || param.multiple;
		const isSwitch = param.flag || param.value !== null;
		const description = [param.help, opt ? `Option ${opt}.` : "Positional argument.",
			!required(param) ? "Omit to use the justfile default." : "Required when running; optional when showing.",
			param.value !== null ? `When true, pass ${opt}; just supplies its configured value.` : null,
		].filter(Boolean).join(" ");
		const property: PropertySchema = { type: isArray ? "array" : isSwitch ? "boolean" : "string", description };
		if (isArray) {
			property.items = { type: "string" };
			if (param.kind === "plus" || (param.multiple && required(param))) property.minItems = Math.max(1, param.min ?? 0);
			else if (param.min != null) property.minItems = param.min;
			if (param.max != null) property.maxItems = param.max;
		}
		properties[param.name] = property;
		if (required(param)) requiredNames.push(param.name);
	}
	const name = optionsName(recipe);
	properties[name] = {
		type: "object",
		description: "Extension options; these are not passed to the recipe. Set show to inspect the recipe instead of running it.",
		properties: {
			grep: { type: "string", description: "JavaScript regular expression; keep matching stdout lines only. Use a focused pattern to reduce output." },
			tail: { type: "number", minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1, description: "Safe integer: return the last N lines of each stream after stdout filtering. Defaults to 25; 0 or a negative value disables tailing and returns the start of each stream, subject to output limits." },
			show: { type: "boolean", description: "Show the current recipe instead of executing it; recipe arguments are not required." },
		},
		additionalProperties: false,
	};
	return {
		type: "object", properties, required: [], additionalProperties: false,
		...(requiredNames.length ? { anyOf: [
			{ required: requiredNames },
			{ required: [name], properties: { [name]: { type: "object", required: ["show"], properties: { show: { type: "boolean", enum: [true] } } } } },
		] } : {}),
	};
}

/** Construct argv, never shell text. Do not materialize just's default expressions. */
export function argvFor(justfile: string, recipe: Recipe, input: Record<string, unknown>, show = false): string[] {
	const schema = schemaFor(recipe);
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected an argument object");
	const parameterNames = new Set(recipe.parameters.map((param) => param.name));
	for (const key of Object.keys(input)) if (!parameterNames.has(key)) throw new Error(`Unknown argument ${key}`);
	const flags: string[] = [];
	const positional: string[] = [];
	let skippedPositional: string | undefined;
	let hasOptions = false;
	for (const param of recipe.parameters) {
		const opt = option(param);
		if (opt) hasOptions = true;
		const value = Object.hasOwn(input, param.name) ? input[param.name] : undefined;
		if (value === undefined) {
			if (!show && required(param)) throw new Error(`Missing required argument ${param.name}`);
			if (!opt && param.kind === "singular") skippedPositional ??= param.name;
			continue;
		}
		const property = schema.properties[param.name];
		if (property.type === "boolean") {
			if (typeof value !== "boolean") throw new Error(`${param.name} must be a boolean`);
			if (value) flags.push(opt!);
			else if (required(param)) throw new Error(`${param.name} must be true`);
			continue;
		}
		const values = property.type === "array" ? value : [value];
		if (!Array.isArray(values) || values.some((item) => typeof item !== "string")) throw new Error(`${param.name} must be ${property.type === "array" ? "an array of strings" : "a string"}`);
		if (property.minItems !== undefined && values.length < property.minItems) throw new Error(`${param.name} requires at least ${property.minItems} values`);
		if (property.maxItems !== undefined && values.length > property.maxItems) throw new Error(`${param.name} permits at most ${property.maxItems} values`);
		if (opt) for (const item of values) flags.push(`${opt}=${item}`);
		else if (values.length) {
			if (!show && skippedPositional) throw new Error(`Cannot supply ${param.name} after omitted positional argument ${skippedPositional}; just cannot skip a positional default`);
			positional.push(...values);
		}
		else if (!opt && param.kind === "singular") skippedPositional ??= param.name;
	}
	if (show) return ["--justfile", justfile, "--show", recipe.path];
	return ["--justfile", justfile, recipe.path, ...flags, ...(hasOptions && positional.length ? ["--"] : []), ...positional];
}
