import type { ApprovalDecision } from "./approval.js";
import { checkHero, crossHero } from "../slots/glyphs.js";

export type ApprovalKeyState = "armed" | "disarmed" | "disconnected";

/**
 * The visual state an Approve/Deny key should show, derived from the same
 * `decideApproval` result that gates the actual key press — so what the key
 * LOOKS like and what it DOES can never disagree. "armed" = pressing acts;
 * "disconnected" = herdr is down; "disarmed" = connected but nothing to act on
 * (no focused agent, or it isn't blocked).
 */
export function approvalKeyState(decision: ApprovalDecision): ApprovalKeyState {
	if (decision.ok) return "armed";
	return decision.reason === "disconnected" ? "disconnected" : "disarmed";
}

// Vivid action colours (match the status palette in slots/render.ts): approve
// green, deny red. Disarmed uses a dark tint of the same hue so the key still
// reads as "the approve key", just inactive.
const ARMED_BG: Record<"approve" | "deny", string> = { approve: "#30a46c", deny: "#e5484d" };
const DISARMED_BG: Record<"approve" | "deny", string> = { approve: "#17352a", deny: "#35171b" };
const DISCONNECTED_BG = "#26262b";

/** Builds the key image (SVG data URI, same shape slotImage() emits) for an
 * Approve or Deny key in the given state. Armed = full-strength glyph on a
 * vivid background; the other states dim the glyph via a group opacity so the
 * key visibly recedes when pressing it would do nothing. */
export function approvalImage(intent: "approve" | "deny", state: ApprovalKeyState): string {
	const hero = intent === "approve" ? checkHero("#ffffff") : crossHero("#ffffff");
	const bg = state === "armed" ? ARMED_BG[intent] : state === "disarmed" ? DISARMED_BG[intent] : DISCONNECTED_BG;
	const opacity = state === "armed" ? 1 : state === "disarmed" ? 0.34 : 0.18;
	const glyph = opacity === 1 ? hero : `<g opacity="${opacity}">${hero}</g>`;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
	<rect width="72" height="72" rx="8" fill="${bg}"/>
	${glyph}
</svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
