// Minimal YAML subset shared by the feature-ledger extension and the capture skill.
// Supports: nested mappings, folded block scalars (>), lists of scalars and objects,
// flow arrays ([a, b]), flow maps ({a: b}), comments, plain and quoted scalars.
// Runs under plain node through native type stripping (Node >= 23; .mise.toml pins node 24).

const KEY = /^([A-Za-z_][\w.-]*):\s*(.*)$/;

type Entry = { indent: number; text: string; lineNo: number };
type Value = unknown;

export function parseYaml(text: string): Record<string, Value> {
	const rawLines = text.split("\n");
	const entries: Entry[] = [];
	for (let i = 0; i < rawLines.length; i++) {
		const line = rawLines[i];
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		entries.push({ indent: line.length - trimmed.length, text: trimmed, lineNo: i });
	}
	if (entries.length === 0) return {};
	const [value, next] = parseNode(entries, rawLines, 0, entries[0].indent);
	if (next < entries.length) throw new Error(`bad line ${entries[next].lineNo + 1}: ${entries[next].text}`);
	return value as Record<string, Value>;
}

function parseNode(entries: Entry[], rawLines: string[], i: number, indent: number): [Value, number] {
	if (entries[i].text.startsWith("- ")) return parseList(entries, rawLines, i, indent);
	return parseMap(entries, rawLines, i, indent);
}

function parseMap(entries: Entry[], rawLines: string[], i: number, indent: number): [Record<string, Value>, number] {
	const map: Record<string, Value> = {};
	while (i < entries.length && entries[i].indent === indent && !entries[i].text.startsWith("- ")) {
		const match = KEY.exec(entries[i].text);
		if (!match) throw new Error(`bad line ${entries[i].lineNo + 1}: ${entries[i].text}`);
		const key = match[1];
		if (Object.hasOwn(map, key)) throw new Error(`duplicate key ${key} on line ${entries[i].lineNo + 1}`);
		const rest = match[2];
		if (rest === ">" || rest === ">-") {
			const [value, next] = readFoldedBlock(entries, rawLines, i, indent);
			map[key] = value;
			i = next;
			continue;
		}
		if (rest === "") {
			if (i + 1 < entries.length && entries[i + 1].indent > indent) {
				const [value, next] = parseNode(entries, rawLines, i + 1, entries[i + 1].indent);
				map[key] = value;
				i = next;
			} else if (i + 1 < entries.length && entries[i + 1].indent === indent && entries[i + 1].text.startsWith("- ")) {
				// A block sequence at the same indent as its key belongs to the key.
				const [value, next] = parseList(entries, rawLines, i + 1, indent);
				map[key] = value;
				i = next;
			} else {
				map[key] = null;
				i += 1;
			}
			continue;
		}
		map[key] = scalar(rest);
		i += 1;
	}
	return [map, i];
}

function parseList(entries: Entry[], rawLines: string[], i: number, indent: number): [Value[], number] {
	const list: Value[] = [];
	while (i < entries.length && entries[i].indent === indent && entries[i].text.startsWith("- ")) {
		const content = entries[i].text.slice(2).trim();
		if (content === "") {
			const [value, next] = parseNode(entries, rawLines, i + 1, entries[i + 1].indent);
			list.push(value);
			i = next;
			continue;
		}
		const match = KEY.exec(content);
		if (match) {
			// Parse the first key like the remaining keys, including nested values.
			const itemEntries = entries.slice();
			itemEntries[i] = { ...entries[i], indent: indent + 2, text: content };
			const [item, next] = parseMap(itemEntries, rawLines, i, indent + 2);
			list.push(item);
			i = next;
			continue;
		}
		let value = scalar(content);
		i += 1;
		// A wrapped list item continues on deeper-indented lines; join them back.
		while (i < entries.length && entries[i].indent > indent && !KEY.test(entries[i].text)) {
			if (typeof value === "string") value = `${value} ${entries[i].text}`;
			i += 1;
		}
		list.push(value);
	}
	return [list, i];
}

function readFoldedBlock(entries: Entry[], rawLines: string[], entryIndex: number, parentIndent: number): [string, number] {
	const lineNo = entries[entryIndex].lineNo;
	const lines: string[] = [];
	let j = lineNo + 1;
	while (j < rawLines.length) {
		const line = rawLines[j];
		const trimmed = line.trim();
		if (trimmed === "") { lines.push(""); j += 1; continue; }
		if (line.length - trimmed.length <= parentIndent) break;
		lines.push(trimmed);
		j += 1;
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	let folded = "";
	for (const line of lines) {
		if (line === "") { folded += "\n"; continue; }
		folded = folded === "" ? line : `${folded} ${line}`;
	}
	let next = entryIndex + 1;
	while (next < entries.length && entries[next].lineNo < j) next += 1;
	return [folded, next];
}

function scalar(text: string): Value {
	if (!text.startsWith("'") && !text.startsWith('"')) {
		const comment = text.indexOf(" #");
		if (comment >= 0) text = text.slice(0, comment).trim();
	}
	if (text.startsWith("[") && text.endsWith("]")) {
		const inner = text.slice(1, -1).trim();
		if (inner === "") return [];
		return splitFlow(inner).map((part) => scalar(part.trim()));
	}
	if (text.startsWith("{") && text.endsWith("}")) {
		const inner = text.slice(1, -1).trim();
		if (inner === "") return {};
		const map: Record<string, Value> = {};
		for (const part of splitFlow(inner)) {
			const separator = part.indexOf(":");
			if (separator < 0) throw new Error(`bad flow map entry: ${part}`);
			map[part.slice(0, separator).trim()] = scalar(part.slice(separator + 1).trim());
		}
		return map;
	}
	if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
	if (text.startsWith('"') && text.endsWith('"')) return JSON.parse(text);
	if (text === "true") return true;
	if (text === "false") return false;
	if (text === "null" || text === "~") return null;
	// A value with a leading zero is not read as a number: a commit hash such as 0092502 must keep its zeros.
	if (/^-?0$/.test(text) || /^-?[1-9]\d*$/.test(text)) return Number(text);
	return text;
}

// Split flow collections only at top-level commas outside quoted scalars.
function splitFlow(text: string): string[] {
	const parts: string[] = [];
	let start = 0, depth = 0, quote = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote === '"' && ch === "\\") { i++; continue; }
		if (quote === "'" && ch === "'" && text[i + 1] === "'") { i++; continue; }
		if (quote) { if (ch === quote) quote = ""; continue; }
		if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "[" || ch === "{") depth++;
		else if (ch === "]" || ch === "}") depth--;
		else if (ch === "," && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
	}
	parts.push(text.slice(start));
	return parts;
}

export function serializeYaml(data: Record<string, Value> | Value[]): string {
	const out: string[] = [];
	emitValue(out, data, 0);
	return `${out.join("\n")}\n`;
}

function emitValue(out: string[], value: Value, indent: number): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			if (item && typeof item === "object" && !Array.isArray(item)) {
				const record = item as Record<string, Value>;
				const keys = Object.keys(record);
				const first = keys[0];
				const firstValue = record[first];
				if (firstValue !== null && typeof firstValue === "object" && Object.keys(firstValue).length > 0) {
					out.push(`${" ".repeat(indent)}- ${first}:`);
					emitValue(out, firstValue, indent + 4);
				} else {
					out.push(`${" ".repeat(indent)}- ${first}: ${formatScalar(firstValue)}`);
				}
				const rest: Record<string, Value> = {};
				for (const key of keys.slice(1)) rest[key] = record[key];
				emitValue(out, rest, indent + 2);
			} else {
				out.push(`${" ".repeat(indent)}- ${formatScalar(item)}`);
			}
		}
		return;
	}
	for (const [key, item] of Object.entries(value as Record<string, Value>)) {
		if (item === null || item === undefined) continue;
		if (typeof item === "string") {
			out.push(`${" ".repeat(indent)}${key}: ${formatScalar(item)}`);
		} else if (Array.isArray(item) || typeof item === "object") {
			if (Array.isArray(item) && item.length === 0) { out.push(`${" ".repeat(indent)}${key}: []`); continue; }
			if (!Array.isArray(item) && Object.keys(item).length === 0) { out.push(`${" ".repeat(indent)}${key}: {}`); continue; }
			out.push(`${" ".repeat(indent)}${key}:`);
			emitValue(out, item, indent + 2);
		} else {
			out.push(`${" ".repeat(indent)}${key}: ${formatScalar(item)}`);
		}
	}
}

function formatScalar(value: Value): string {
	if (value === null) return "null";
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value) && value.length === 0) return "[]";
	if (typeof value === "object" && value && Object.keys(value).length === 0) return "{}";
	const text = String(value);
	if (text === "") return "''";
	if (text.trim() === text && /^[A-Za-z0-9_./\- ]+$/.test(text) && !text.startsWith("- ") && !/^-?\d+$/.test(text) && !["true", "false", "null", "~"].includes(text)) return text;
	return JSON.stringify(text);
}
