import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const check = fileURLToPath(new URL("./check.ts", import.meta.url));
const example = fileURLToPath(new URL("../../configs/provider-rules.example.jsonc", import.meta.url));

test("explicit config does not probe personal paths and still reports invalid fixtures", async () => {
	const dir = await mkdtemp(join(tmpdir(), "provider-check-test-"));
	try {
		const guard = join(dir, "guard.mjs");
		await writeFile(guard, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const exists = fs.existsSync;
fs.existsSync = function(path) { if (String(path).startsWith(process.env.HOME + '/.pi/agent/')) throw new Error('probed personal config'); return exists.apply(this, arguments); };
syncBuiltinESMExports();\n`);
		const env = { ...process.env, HOME: dir, NODE_OPTIONS: `--import=${guard}` };
		const valid = execFileSync(process.execPath, [check, "--config", example], { env, encoding: "utf8" });
		assert.match(valid, /provider-rules\.example\.jsonc/);
		assert.match(valid, /configured:/);
		const invalid = join(dir, "invalid.jsonc");
		await writeFile(invalid, '{"recovery":{"maxAttempts":0}}');
		const result = spawnSync(process.execPath, [check, "--config", invalid], { env, encoding: "utf8" });
		assert.equal(result.status, 1);
		assert.match(result.stdout, /maxAttempts: must be a positive integer/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("default check still selects the current or legacy personal config", async () => {
	const dir = await mkdtemp(join(tmpdir(), "provider-check-default-"));
	try {
		const agent = join(dir, ".pi", "agent");
		await mkdir(agent, { recursive: true });
		await writeFile(join(agent, "provider-prompt-rules.jsonc"), "{}");
		const env = { ...process.env, HOME: dir };
		const legacy = execFileSync(process.execPath, [check], { env, encoding: "utf8" });
		assert.match(legacy, /legacy path/);
		await writeFile(join(agent, "provider-rules.jsonc"), "{}");
		const current = execFileSync(process.execPath, [check], { env, encoding: "utf8" });
		assert.match(current, /provider-rules\.jsonc/);
		assert.doesNotMatch(current, /legacy path/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
