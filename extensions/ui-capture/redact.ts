// Remove `userinfo@` credentials from any URL shown to the agent or persisted. The userinfo ends at the
// LAST `@` of the authority, so a password containing `@` does not leak.
export function redactUrl(url: string): string {
	return url.replace(/(\/\/)[^\/?#\s]*@/g, "$1");
}
