export interface KeySequence {
	approve: string[];
	deny: string[];
}

export type KeymapTable = Record<string, KeySequence>;

/**
 * The key-NAME vocabulary is verified against the live herdr server (probed
 * via an isolated scratch pane): it's crossterm `KeyCode` names - Backspace,
 * Enter, Left, Right, Up, Down, Home, End, PageUp, PageDown, Tab, BackTab,
 * Delete, Insert, Esc, CapsLock, ScrollLock, NumLock, PrintScreen, Pause,
 * Menu, KeypadBegin, Null, F1-F12, and single characters (e.g. "y", "1").
 * Names are case-insensitive. Modifiers use `+`, not `-` (e.g. "ctrl+c").
 * Notably, "Escape" is REJECTED - the accepted spelling is "Esc".
 *
 * What is still UNVERIFIED PLACEHOLDER is the SEQUENCE per agent CLI below:
 * nobody has yet sat a real Claude Code or Codex session at an approval
 * prompt and confirmed that Enter accepts and Esc rejects. That remains an
 * open item resolved in Task 11 of the implementation plan. Any agent not
 * listed here falls back to `default`.
 */
export const DEFAULT_KEYMAP: KeymapTable = {
	claude: { approve: ["Enter"], deny: ["Esc"] },
	codex: { approve: ["Enter"], deny: ["Esc"] },
	default: { approve: ["Enter"], deny: ["Esc"] },
};

function isKeymapTableShape(value: unknown): value is KeymapTable {
	return typeof value === "object" && value !== null;
}

export function resolveKeymap(
	agentLabel: string,
	table: KeymapTable = DEFAULT_KEYMAP,
	override?: Partial<KeySequence>,
): KeySequence {
	// `table` may originate from a user-edited JSON file (wired in a later
	// task), so treat every lookup as potentially malformed: a missing
	// `default` entry, an agent entry missing `approve`/`deny`, a table that
	// isn't even an object (e.g. the JSON file's entire content is `null`,
	// a number, or a string - the default parameter only substitutes for
	// `undefined`, not for these), or (since callers may pass loosely-typed
	// data at runtime despite the `string` annotation) a non-string label
	// must all degrade to a safe key sequence instead of throwing.
	const effectiveTable = isKeymapTableShape(table) ? table : DEFAULT_KEYMAP;
	const key = typeof agentLabel === "string" ? agentLabel.toLowerCase() : "";
	const tableDefault = effectiveTable.default;
	const base = effectiveTable[key] ?? tableDefault;
	return {
		approve:
			override?.approve ?? base?.approve ?? tableDefault?.approve ?? DEFAULT_KEYMAP.default.approve,
		deny: override?.deny ?? base?.deny ?? tableDefault?.deny ?? DEFAULT_KEYMAP.default.deny,
	};
}
