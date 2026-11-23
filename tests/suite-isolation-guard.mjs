// Preloaded in isolated suite subprocesses; the log is outside the guarded home.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const forbidden = resolve(process.env.ISOLATION_GUARD_HOME, ".pi");
const log = process.env.ISOLATION_GUARD_LOG;
const append = fs.appendFileSync;

function check(value, operation) {
	let path;
	if (typeof value === "string") path = value;
	else if (Buffer.isBuffer(value)) path = value.toString();
	else if (value instanceof URL && value.protocol === "file:") path = fileURLToPath(value);
	else return;
	path = resolve(path);
	if (path === forbidden || path.startsWith(forbidden + sep)) {
		// One synchronous append per violation keeps records independent across child processes.
		append.call(fs, log, JSON.stringify({ operation, path }) + "\n");
		throw new Error(`personal Pi access: ${path}`);
	}
}

function wrap(object, name, twoPaths = false) {
	const original = object[name];
	if (typeof original !== "function") return;
	object[name] = function (...args) {
		check(args[0], name);
		if (twoPaths) check(args[1], name);
		return original.apply(this, args);
	};
}

for (const name of ["existsSync", "readFileSync", "writeFileSync", "appendFileSync", "statSync", "lstatSync", "accessSync", "mkdirSync", "openSync", "readdirSync", "unlinkSync", "rmSync", "rmdirSync", "readlinkSync", "opendirSync", "exists", "readFile", "writeFile", "appendFile", "stat", "lstat", "access", "mkdir", "open", "readdir", "unlink", "rm", "rmdir", "readlink", "opendir", "createReadStream", "createWriteStream", "watch"]) wrap(fs, name);
for (const name of ["renameSync", "copyFileSync", "cpSync", "linkSync", "symlinkSync", "rename", "copyFile", "cp", "link", "symlink"]) wrap(fs, name, true);
for (const name of ["readFile", "writeFile", "appendFile", "stat", "lstat", "access", "mkdir", "open", "readdir", "unlink", "rm", "rmdir", "readlink", "opendir"]) wrap(fs.promises, name);
for (const name of ["rename", "copyFile", "cp", "link", "symlink"]) wrap(fs.promises, name, true);
syncBuiltinESMExports();
