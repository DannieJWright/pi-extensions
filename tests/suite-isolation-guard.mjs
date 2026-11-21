// Preloaded in isolated suite subprocesses; the log is outside the guarded home.
//
// The guard is lexical, not a sandbox: it compares resolved path strings. A symlink inside the allowed
// package prefix that points elsewhere under ~/.pi is not detected.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const forbidden = resolve(process.env.ISOLATION_GUARD_HOME, ".pi");
// Installed package code is a dependency, not user state, so read operations on it are allowed.
// Writes, deletes and renames stay blocked everywhere under ~/.pi.
const packageRoot = resolve(forbidden, "agent", "npm", "node_modules");
const log = process.env.ISOLATION_GUARD_LOG;
const append = fs.appendFileSync;
const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;

function isReadFlags(flags) {
	if (flags === undefined) return true;
	if (typeof flags === "number") return (flags & WRITE_FLAGS) === 0;
	return typeof flags === "string" && flags.startsWith("r") && !flags.includes("+");
}

function check(value, operation, readOnly) {
	let path;
	if (typeof value === "string") path = value;
	else if (Buffer.isBuffer(value)) path = value.toString();
	else if (value instanceof URL && value.protocol === "file:") path = fileURLToPath(value);
	else return;
	path = resolve(path);
	if (readOnly && (path === packageRoot || path.startsWith(packageRoot + sep))) return;
	if (path === forbidden || path.startsWith(forbidden + sep)) {
		// One synchronous append per violation keeps records independent across child processes.
		append.call(fs, log, JSON.stringify({ operation, path }) + "\n");
		throw new Error(`personal Pi access: ${path}`);
	}
}

const READ_OPERATIONS = new Set(["existsSync", "readFileSync", "statSync", "lstatSync", "accessSync", "readdirSync", "readlinkSync", "opendirSync", "exists", "readFile", "stat", "lstat", "access", "readdir", "readlink", "opendir", "createReadStream"]);

function wrap(object, name, twoPaths = false) {
	const original = object[name];
	if (typeof original !== "function") return;
	const opens = name === "open" || name === "openSync";
	object[name] = function (...args) {
		const readOnly = !twoPaths && (READ_OPERATIONS.has(name) || (opens && isReadFlags(args[1])));
		check(args[0], name, readOnly);
		if (twoPaths) check(args[1], name, false);
		return original.apply(this, args);
	};
}

for (const name of ["existsSync", "readFileSync", "writeFileSync", "appendFileSync", "statSync", "lstatSync", "accessSync", "mkdirSync", "openSync", "readdirSync", "unlinkSync", "rmSync", "rmdirSync", "readlinkSync", "opendirSync", "exists", "readFile", "writeFile", "appendFile", "stat", "lstat", "access", "mkdir", "open", "readdir", "unlink", "rm", "rmdir", "readlink", "opendir", "createReadStream", "createWriteStream", "watch"]) wrap(fs, name);
for (const name of ["renameSync", "copyFileSync", "cpSync", "linkSync", "symlinkSync", "rename", "copyFile", "cp", "link", "symlink"]) wrap(fs, name, true);
for (const name of ["readFile", "writeFile", "appendFile", "stat", "lstat", "access", "mkdir", "open", "readdir", "unlink", "rm", "rmdir", "readlink", "opendir"]) wrap(fs.promises, name);
for (const name of ["rename", "copyFile", "cp", "link", "symlink"]) wrap(fs.promises, name, true);
syncBuiltinESMExports();
