/**
 * Shared status-glyph vocabulary. Each function returns an SVG *fragment*
 * (no `<svg>` wrapper) meant to be spliced inside a
 * `<svg ... viewBox="0 0 72 72">` — the same 72x72 key space slotImage() uses
 * in render.ts. Centralising the shapes here keeps the static action icons
 * (imgs/actions/*), the slot renderer, and the Approve/Deny keys drawing the
 * SAME mark for the same concept, and makes status encoding non-colour (a
 * distinct shape per state) so a colour-blind user can tell working from idle
 * without relying on hue.
 *
 * Two families:
 *  - "hero" glyphs are large and centred, for a whole-key icon.
 *  - "badge" glyphs are small, default-positioned in the top-right corner,
 *    for overlaying on a key that already carries text.
 */

/** Big centred checkmark — the "approve / ok" mark. */
export function checkHero(color = "#ffffff"): string {
	return `<path d="M22 37 L32 48 L52 24" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** Big centred X — the "deny / reject" mark. Same visual family as the
 * disconnected glyph, one size up. */
export function crossHero(color = "#ffffff"): string {
	return `<path d="M25 25 L47 47 M47 25 L25 47" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"/>`;
}

/** The disconnected "X" drawn key-sized. Kept here so render.ts and the
 * action icons share one definition. */
export function disconnectedGlyph(color = "#e5484d"): string {
	return `<line x1="24" y1="20" x2="48" y2="44" stroke="${color}" stroke-width="5" stroke-linecap="round"/>
	<line x1="48" y1="20" x2="24" y2="44" stroke="${color}" stroke-width="5" stroke-linecap="round"/>`;
}

/** Traffic-light of the three real status colours, stacked vertically. Used
 * as the neutral tray/default icon for the Agent Slot action so the icon
 * itself says "this shows agent status". */
export function agentHero(): string {
	return `<circle cx="36" cy="18" r="6" fill="#e5484d"/>
	<circle cx="36" cy="36" r="6" fill="#f5a524"/>
	<circle cx="36" cy="54" r="6" fill="#30a46c"/>`;
}

/** Blocked badge: white "!" in a red disc. Lifted verbatim from render.ts's
 * existing blocked glyph so the two never drift. Default corner is top-right. */
export function blockedBadge(cx = 60, cy = 12): string {
	return `<circle cx="${cx}" cy="${cy}" r="9" fill="#e5484d" stroke="#ffffff" stroke-width="2"/>
	<line x1="${cx}" y1="${cy - 5}" x2="${cx}" y2="${cy + 1.5}" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
	<circle cx="${cx}" cy="${cy + 4.5}" r="1.4" fill="#ffffff"/>`;
}

/** Working badge: a spinner-style ring with a gap — reads as "in progress".
 * Dark stroke because the working status background (#f5a524 amber) is light. */
export function workingBadge(cx = 60, cy = 12): string {
	return `<circle cx="${cx}" cy="${cy}" r="6" fill="none" stroke="#141414" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="20 12" transform="rotate(-90 ${cx} ${cy})"/>`;
}

/** Idle badge: a solid dot — reads as "ready / steady". White because the
 * idle status background (#30a46c green) is dark. */
export function idleBadge(cx = 60, cy = 12): string {
	return `<circle cx="${cx}" cy="${cy}" r="5.5" fill="#ffffff"/>`;
}
