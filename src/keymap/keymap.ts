export interface KeySequence {
	approve: string[];
	deny: string[];
}

export type KeymapTable = Record<string, KeySequence>;

/**
 * UNVERIFIED PLACEHOLDERS. The key-name vocabulary accepted by herdr's
 * `pane.send_keys`, and the correct approve/deny sequence per agent CLI, are
 * both open items resolved in Task 11 of the implementation plan. Any agent not
 * listed here falls back to `default`.
 */
export const DEFAULT_KEYMAP: KeymapTable = {
	claude: { approve: ["Enter"], deny: ["Escape"] },
	codex: { approve: ["Enter"], deny: ["Escape"] },
	default: { approve: ["Enter"], deny: ["Escape"] },
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
