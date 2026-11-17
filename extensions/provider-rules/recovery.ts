// Decision logic for truncation recovery. No Pi imports: the extension supplies the facts, this
// module decides, and the tests run against the same code.

import type { ActiveRecovery, ThinkingLevelName } from "./config.ts";

export type ActivityOutcome = "completed" | "aborted" | "error";

/** customType of the message this extension injects before the retry. */
export const RECOVERY_CUSTOM_TYPE = "provider-rules.recovery";

/** What happened in one turn, reduced to the facts the decision needs. */
export interface TurnFacts {
	outcome: ActivityOutcome;
	/** Stop reason of the assistant message. */
	stopReason: string;
	/** The assistant message carried a text block, so it was not thinking only. */
	hasText: boolean;
	/** Number of tool results executed in this turn. */
	toolResults: number;
	/** Thinking level in effect for this turn. */
	thinkingLevel: ThinkingLevelName | null;
}

export interface RecoveryState {
	/** Consecutive recovery attempts in this session. */
	attempts: number;
	/** Level to restore after the recovery turn, or null when nothing was lowered. */
	pendingRestore: ThinkingLevelName | null;
	/** Whether the attempt limit has already been reported. */
	reportedLimit: boolean;
}

export function initialState(): RecoveryState {
	return { attempts: 0, pendingRestore: null, reportedLimit: false };
}

/** A length stop with no text and no tool calls: the whole response went to thinking. */
export function isTruncatedThinking(facts: TurnFacts): boolean {
	return facts.outcome === "completed" && facts.stopReason === "length" && !facts.hasText && facts.toolResults === 0;
}

export interface Decision {
	/** Level to restore before anything else, or null. */
	restore: ThinkingLevelName | null;
	/** What to do for this turn. */
	action: "none" | "recover" | "limit";
	/** Whether the attempt counter was reset by this turn. */
	reset: boolean;
	/** Set when the action is recover. */
	prompt?: string;
	display?: boolean;
	/** Level to use for the recovery request, or null to leave it unchanged. */
	setLevel?: ThinkingLevelName | null;
	/** Whether this is the first time the limit was reached, so it is reported once. */
	notify?: boolean;
}

/**
 * Decide what to do at the end of a turn. Pure: takes the current state, returns the next state.
 * Order matters — restore first, then lower again for the next attempt.
 */
export function planTurn(state: RecoveryState, recovery: ActiveRecovery, facts: TurnFacts): { decision: Decision; state: RecoveryState } {
	const next: RecoveryState = { ...state };

	// This turn ran with a level this extension lowered, so put it back first.
	const restore = next.pendingRestore;
	next.pendingRestore = null;

	if (!isTruncatedThinking(facts)) {
		// A normal turn ends the recovery streak.
		const reset = facts.outcome === "completed";
		if (reset) {
			next.attempts = 0;
			next.reportedLimit = false;
		}
		return { decision: { restore, action: "none", reset }, state: next };
	}

	if (!recovery.allowed) {
		return { decision: { restore, action: "none", reset: false }, state: next };
	}

	if (next.attempts >= recovery.settings.maxAttempts) {
		const notify = !next.reportedLimit;
		next.reportedLimit = true;
		return { decision: { restore, action: "limit", reset: false, notify }, state: next };
	}

	next.attempts += 1;
	// The level to restore after the recovery request is the one this turn would have used,
	// which is the level we just restored (or the level this turn actually ran with).
	const levelToRestore = restore ?? facts.thinkingLevel;
	const setLevel = recovery.settings.thinkingLevel;
	if (setLevel !== null && levelToRestore !== null) next.pendingRestore = levelToRestore;

	return {
		decision: {
			restore,
			action: "recover",
			reset: false,
			prompt: recovery.settings.prompt,
			display: recovery.settings.display,
			setLevel,
		},
		state: next,
	};
}

/** Text for the notification when the attempt limit is reached. */
export function limitMessage(maxAttempts: number): string {
	return `reached the attempt limit (${maxAttempts}); stopping recovery.`;
}
