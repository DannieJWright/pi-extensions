// JSONC reader: `//` and `/* */` comments, trailing commas. No dependencies.

/** Remove comments and trailing commas. String literals are left untouched. */
export function stripJsonc(text: string): string {
	let out = "";
	let i = 0;

	while (i < text.length) {
		const ch = text[i];

		if (ch === '"') {
			out += ch;
			i += 1;
			while (i < text.length) {
				const c = text[i];
				if (c === "\\") {
					out += text.slice(i, i + 2);
					i += 2;
					continue;
				}
				out += c;
				i += 1;
				if (c === '"') break;
			}
			continue;
		}

		if (ch === "/" && text[i + 1] === "/") {
			out += " ";
			while (i < text.length && text[i] !== "\n") i += 1;
			continue;
		}

		if (ch === "/" && text[i + 1] === "*") {
			out += " ";
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
			if (i >= text.length) throw new JsoncError("Unterminated block comment in JSONC.");
			i += 2;
			continue;
		}

		if (ch === ",") {
			// A comma before a closing bracket is trailing: drop it. Comments after it do not count.
			if (nextMeaningful(text, i + 1) === "}" || nextMeaningful(text, i + 1) === "]") {
				i += 1;
				continue;
			}
		}

		out += ch;
		i += 1;
	}

	return out;
}

function nextMeaningful(text: string, from: number): string | null {
	let i = from;
	while (i < text.length) {
		const ch = text[i];
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			i += 1;
			continue;
		}
		if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i += 1;
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
			i += 2;
			continue;
		}
		return ch;
	}
	return null;
}

export class JsoncError extends Error {}

export function parseJsonc(text: string, sourceName: string): unknown {
	try {
		return JSON.parse(stripJsonc(text));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new JsoncError(`${sourceName}: not valid JSONC (${message}). Positions refer to the text after comments are removed.`);
	}
}
