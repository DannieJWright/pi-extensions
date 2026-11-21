import test from "node:test";
import assert from "node:assert/strict";
import { stripJsonc } from "../../lib/jsonc.ts";
import { parseRoundtripJson } from "./json-roundtrip.ts";

test("parseRoundtripJson checks overwritten numbers and ignores strings and JSONC comments", () => {
	for (const number of ["9007199254740993", "-0", "1e400", "1e-400"]) {
		const text = `{"text":"\\\" ${number} \\\\ still a string", /* ${number} */ "x":${number}, "x":1}`;
		assert.throws(() => parseRoundtripJson(stripJsonc(text), "source.jsonc", "stripped JSONC"), new RegExp(`${number}.*cannot be preserved`));
	}
	assert.throws(() => parseRoundtripJson('{"x":{"nested":[9007199254740993]},"x":1}', "source.json"), /source\.json: number 9007199254740993 at offset 16 cannot be preserved/);
	const text = '{"text":"\\\" 9007199254740993 \\\\ -0", // 1e400\n "x":1.00,"x":2, "numbers":[0.1,10e-1,1e21,0.0],}';
	assert.deepEqual(parseRoundtripJson(stripJsonc(text), "source.jsonc", "stripped JSONC"), { text: '" 9007199254740993 \\ -0', x: 2, numbers: [0.1, 1, 1e21, 0] });
	assert.throws(() => parseRoundtripJson('{"x":1,}', "bad.json"), SyntaxError);
});
