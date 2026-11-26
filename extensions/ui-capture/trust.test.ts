import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseCommand, readAllowedCommands, trustCommand } from "./trust.ts";

test("shell-free just uses parsed argv, including quotes and escapes", () => {
	assert.deepEqual(trustCommand(`just run 'two words' "a;b" escaped\\ space`, []), { command: `just run 'two words' "a;b" escaped\\ space`, argv: ["just", "run", "two words", "a;b", "escaped space"], shell: false });
	assert.throws(() => parseCommand("just 'unterminated"), /unclosed quote/);
	assert.throws(() => parseCommand("just trailing\\"), /unclosed quote/);
	assert.throws(() => parseCommand("just run\necho bad"), /malformed/);
});

test("shell syntax and other executables require a full-command allowlist match", () => {
	for (const command of ["just run; echo bad", "just run | cat", "just run > log", "just run $(id)", "just run $HOME", "node server.js", "just run *.js"]) {
		assert.throws(() => trustCommand(command, []), error => error instanceof Error && error.message.includes(JSON.stringify(command)));
	}
	assert.equal(trustCommand("just run; echo ok", ["just run; echo *"]).shell, true);
	assert.deepEqual(trustCommand("node server.js", ["node server.js"]).argv, ["node", "server.js"]);
	assert.throws(() => trustCommand("node server.js extra", ["node server.js"]), /Untrusted/);
	assert.equal(trustCommand("just run '$HOME'", []).shell, false);
	assert.throws(() => trustCommand('just run "$HOME"', []), /Untrusted/);
});

test("allowlist reads JSONC and rejects malformed configuration", async () => {
	const dir = await mkdtemp(join(tmpdir(), "capture-trust-"));
	try {
		const path = join(dir, "config.jsonc");
		assert.deepEqual(await readAllowedCommands(path), []);
		await writeFile(path, '{ // operator trust\n "allowedCommands": ["node server*",],\n}');
		assert.deepEqual(await readAllowedCommands(path), ["node server*"]);
		await writeFile(path, '{"allowedCommands":[3]}');
		await assert.rejects(readAllowedCommands(path), /array of strings/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
