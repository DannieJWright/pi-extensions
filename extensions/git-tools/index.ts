import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { normalizeJsonEncoded } from "../../lib/args.ts";
import { inspectGit } from "./git.ts";

const paths = { type: "array", items: { type: "string" }, maxItems: 100, description: "Literal paths relative to dir when it is given, otherwise to the session working directory; no Git pathspec magic." };
const ref = { type: "string", description: "Simple commit hash, branch, or tag name (no revision operators)." };
// Shared optional run directory. It has no path gate, so absolute paths outside the session subtree are accepted; the value is resolved and checked inside inspectGit.
const dir = { type: "string", maxLength: 4096, description: "Directory to run in. Absolute, or relative to the session working directory. Must exist and be a directory. Defaults to the session working directory." };
const definitions = [
 { kind: "diff", description: "Inspect unstaged, staged, or committed range changes.", properties: { mode: { type: "string", enum: ["unstaged", "staged", "range"], description: "Defaults to unstaged; range requires from and to." }, from: ref, to: ref, paths, dir }, required: [] },
 { kind: "status", description: "Inspect branch, index, working-tree and untracked status.", properties: { dir }, required: [] },
 { kind: "log", description: "Inspect bounded commit history.", properties: { ref, limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum commits, default 20." }, paths, dir }, required: [] },
 { kind: "show", description: "Inspect one commit and its changes.", properties: { ref, paths, dir }, required: ["ref"] },
] as const;

export default function gitTools(pi: ExtensionAPI): void {
 for (const definition of definitions) {
  const parameters = { type: "object", properties: definition.properties, required: definition.required, additionalProperties: false } as unknown as TSchema;
  pi.registerTool({
   name: `git_r_${definition.kind}`, label: `Git ${definition.kind}`, description: `${definition.description} Runs in dir when it is given, otherwise the session working directory, with bounded output and runtime.`,
   parameters,
   // prepareArguments is typed (args: unknown) => Static<TParams>; normalizeJsonEncoded returns unknown, so an explicit `as never` cast is used, not a generic.
   prepareArguments: (args) => normalizeJsonEncoded(parameters, args) as never,
   async execute(_id, args, signal, _onUpdate, ctx) { return inspectGit(definition.kind, args as Record<string, unknown>, { cwd: ctx.cwd, signal }); },
  });
 }
}
