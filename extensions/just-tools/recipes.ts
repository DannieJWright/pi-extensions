import { parseJsonc } from "../../lib/jsonc.ts";

export interface RecipeParameter {
	name: string;
	default: unknown;
	kind: "singular" | "star" | "plus";
	flag: boolean;
	long: string | null;
	short: string | null;
	value: string | null;
	help: string | null;
	multiple: boolean;
	pattern: string[] | null;
	min: number | null;
	max: number | null;
}

export interface Recipe {
	name: string;
	path: string;
	doc: string | null;
	parameters: RecipeParameter[];
}

export interface Config {
	include?: string[];
	exclude?: string[];
}

/** Local keys replace matching global keys; unspecified local keys inherit. */
export function mergeConfig(globalConfig: Config, localConfig: Config): Config {
	return { ...globalConfig, ...localConfig };
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseConfig(text: string, source: string): Config {
	const data = parseJsonc(text, source);
	if (!object(data)) throw new Error(`${source}: expected an object`);
	for (const key of Object.keys(data)) {
		if (key !== "include" && key !== "exclude") throw new Error(`${source}: unknown key ${JSON.stringify(key)}`);
		const value = data[key];
		if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry)) {
			throw new Error(`${source}: ${key} must be an array of non-empty recipe names`);
		}
	}
	return data as Config;
}

/** `just --summary` supplies visibility, including private parent modules. */
export function collectRecipes(data: unknown, publicNames: Set<string>): Recipe[] {
	const recipes: Recipe[] = [];
	function visit(module: unknown, prefix: string[]): void {
		if (!object(module) || !object(module.recipes) || !object(module.modules)) {
			throw new Error("Unsupported just JSON: missing recipes or modules");
		}
		for (const [name, raw] of Object.entries(module.recipes)) {
			if (!object(raw) || typeof raw.private !== "boolean" || !Array.isArray(raw.parameters)) {
				throw new Error(`Unsupported just JSON for recipe ${[...prefix, name].join("::")}`);
			}
			const path = [...prefix, name].join("::");
			if (raw.private || !publicNames.has(path)) continue;
			const parameters = raw.parameters.map((param): RecipeParameter => {
				if (!object(param) || typeof param.name !== "string" ||
					(param.kind !== "singular" && param.kind !== "star" && param.kind !== "plus") ||
					typeof param.flag !== "boolean") {
					throw new Error(`Unsupported parameter metadata in recipe ${path}`);
				}
				return param as unknown as RecipeParameter;
			});
			recipes.push({ name, path, doc: typeof raw.doc === "string" ? raw.doc : null, parameters });
		}
		for (const [name, child] of Object.entries(module.modules)) {
			if (object(child) && child.private === true) continue;
			visit(child, [...prefix, name]);
		}
	}
	visit(data, []);
	return recipes;
}

export function selectRecipes(recipes: Recipe[], config: Config): Recipe[] {
	const known = new Set(recipes.map((recipe) => recipe.path));
	for (const name of [...(config.include ?? []), ...(config.exclude ?? [])]) {
		if (!known.has(name)) throw new Error(`Unknown or private recipe in config: ${name}`);
	}
	const include = config.include === undefined ? undefined : new Set(config.include);
	const exclude = new Set(config.exclude ?? []);
	return recipes.filter((recipe) => (!include || include.has(recipe.path)) && !exclude.has(recipe.path));
}

/** Make a readable, provider-safe name without project-specific suffixes. */
export function toolName(recipePath: string): string {
	const display = recipePath.split("::").map((part) => part
		.replace(/_/g, "_u")
		.replace(/[^A-Za-z0-9-]/g, (char) => `_x${char.codePointAt(0)!.toString(16)}_`)
		.replace(/-/g, "_"))
		.join("_m");
	const name = `just_${display}`;
	if (name.length > 64) throw new Error(`Recipe name is too long for a Pi tool: ${recipePath}`);
	return name;
}
