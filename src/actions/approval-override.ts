import type { KeySequence } from "../keymap/keymap.js";

/**
 * Parses a whitespace-or-comma-separated key list (as typed in the property
 * inspector, e.g. "y" or "ctrl+c, Enter") into a key SEQUENCE. Returns
 * `undefined` — never `[]` — for blank/absent input, because resolveKeymap
 * coalesces the override with `??`: an empty array would NOT fall through to
 * the base keymap, it would stick and make decideApproval reject the press
 * with `empty-keys`. Key NAMES are not validated here (herdr validates its own
 * vocabulary on send); this only splits and trims.
 */
export function parseKeyList(value: string | undefined): string[] | undefined {
	if (typeof value !== "string") return undefined;
	const keys = value.split(/[,\s]+/).map((k) => k.trim()).filter((k) => k.length > 0);
	return keys.length > 0 ? keys : undefined;
}

/**
 * Builds the `Partial<KeySequence>` override from the property inspector's two
 * string settings. Returns `undefined` when neither field is set, so
 * resolveKeymap uses the base keymap untouched. Only the field(s) the user
 * actually filled in are included — a blank Approve box does not override
 * Approve.
 */
export function overrideFromSettings(settings: {
	approveKeys?: string;
	denyKeys?: string;
}): Partial<KeySequence> | undefined {
	const approve = parseKeyList(settings.approveKeys);
	const deny = parseKeyList(settings.denyKeys);
	if (!approve && !deny) return undefined;
	const override: Partial<KeySequence> = {};
	if (approve) override.approve = approve;
	if (deny) override.deny = deny;
	return override;
}
