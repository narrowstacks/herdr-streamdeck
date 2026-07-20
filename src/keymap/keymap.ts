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

export interface KeymapLoadResult {
	table: KeymapTable;
	warnings: string[];
}

function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v.length > 0);
}

function isRawSequenceShape(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Turns an arbitrary parsed JSON value (the loaded keymap.json, or anything a
 * hand-edit could produce) into a trustworthy KeymapTable, never throwing.
 *
 * Closes two gaps a hand-edited config could otherwise hit silently:
 *  - agent-label keys are lowercased here, matching resolveKeymap()'s
 *    lowercase lookup — an entry written as "Claude" would otherwise never
 *    match "claude" and would fall through to `default` with no signal.
 *  - an entry whose `approve` or `deny` is missing, not an array, or an empty
 *    array is dropped at load time (with a warning) rather than accepted and
 *    only failing later, silently, when decideApproval() refuses to send zero
 *    keystrokes.
 *
 * If the input isn't an object at all, or ends up with no usable `default`
 * entry after invalid entries are dropped, this falls back to DEFAULT_KEYMAP
 * wholesale — a broken config must not stop the plugin from having *a*
 * working keymap.
 */
export function normalizeKeymapTable(raw: unknown): KeymapLoadResult {
	const warnings: string[] = [];

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warnings.push("keymap.json is not a JSON object; using the built-in keymap");
		return { table: DEFAULT_KEYMAP, warnings };
	}

	const table: KeymapTable = {};
	for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
		if (rawKey === "_comment") continue;

		const key = rawKey.toLowerCase();
		if (Object.prototype.hasOwnProperty.call(table, key)) {
			warnings.push(
				`keymap.json has a duplicate entry for "${key}" (case-insensitive collision on "${rawKey}"); keeping the first, dropping this one`,
			);
			continue;
		}

		if (!isRawSequenceShape(rawValue)) {
			warnings.push(`keymap.json entry "${rawKey}" is not an object; dropped`);
			continue;
		}

		const approve = rawValue.approve;
		const deny = rawValue.deny;
		if (!isNonEmptyStringArray(approve) || !isNonEmptyStringArray(deny)) {
			warnings.push(
				`keymap.json entry "${rawKey}" has a missing or empty approve/deny key list; dropped (an Approve/Deny key for it would silently do nothing)`,
			);
			continue;
		}

		table[key] = { approve, deny };
	}

	if (!table.default) {
		warnings.push("keymap.json has no valid 'default' entry after validation; using the built-in keymap");
		return { table: DEFAULT_KEYMAP, warnings };
	}

	return { table, warnings };
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
