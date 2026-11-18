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
	const [value] = parseNode(entries, rawLines, 0, entries[0].indent);
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
			const item: Record<string, Value> = {};
			if (match[2] !== "") item[match[1]] = unquote(scalar(match[2]));
			i += 1;
			const [rest, next] = parseMap(entries, rawLines, i, indent + 2);
			Object.assign(item, rest);
			list.push(item);
			i = next;
			continue;
		}
		let value = unquote(scalar(content));
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
		return inner.split(",").map((part) => scalar(part.trim()));
	}
	if (text.startsWith("{") && text.endsWith("}")) {
		const inner = text.slice(1, -1).trim();
		if (inner === "") return {};
		const map: Record<string, Value> = {};
		for (const part of inner.split(",")) {
			const separator = part.indexOf(":");
			if (separator < 0) throw new Error(`bad flow map entry: ${part}`);
			map[part.slice(0, separator).trim()] = scalar(part.slice(separator + 1).trim());
		}
		return map;
	}
	if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) return text.slice(1, -1);
	if (/^-?\d+$/.test(text)) return Number(text);
	return text;
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
				out.push(`${" ".repeat(indent)}- ${first}: ${formatScalar(record[first])}`);
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
			if (item.includes("\n") || item.length > 70) {
				out.push(`${" ".repeat(indent)}${key}: >`);
				for (const line of wrap(item)) out.push(`${" ".repeat(indent + 2)}${line}`);
			} else {
				out.push(`${" ".repeat(indent)}${key}: ${formatScalar(item)}`);
			}
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
	if (typeof value === "number") return String(value);
	const text = String(value);
	if (text === "") return "''";
	if (/^-?\d+$/.test(text)) return text;
	if (/^[A-Za-z0-9_./\- ]+$/.test(text) && !text.startsWith("- ") && !text.includes(": ")) return text;
	return `'${text.replace(/'/g, "''")}'`;
}

function unquote(text: string): string {
	return text.replace(/''/g, "'");
}

function wrap(text: string): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (paragraph === "") { lines.push(""); continue; }
		const words = paragraph.split(" ");
		let current = "";
		for (const word of words) {
			if (current === "") current = word;
			else if (current.length + word.length + 1 <= 70) current += ` ${word}`;
			else { lines.push(current); current = word; }
		}
		lines.push(current);
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}
