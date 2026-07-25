import type { AgentStatus } from "../herdr/types.js";
import { blockedBadge, disconnectedGlyph, idleBadge, workingBadge } from "./glyphs.js";

export type SlotRender =
	| { kind: "agent"; status: AgentStatus; agent: string; project: string }
	| { kind: "unclaimed" }
	| { kind: "disconnected" };

const COLORS: Record<AgentStatus, string> = {
	blocked: "#e5484d",
	working: "#f5a524",
	idle: "#30a46c",
	unknown: "#6f6f6f",
};

const UNCLAIMED_COLOR = "#111111";
const DISCONNECTED_COLOR = "#3a2a2a";

// Character budgets for the in-icon labels. A Stream Deck key is 72px wide, so
// even the label lines have to be capped: past roughly these lengths a
// proportional font at the sizes used below runs off the key. `truncate`
// enforces them with a trailing ellipsis; the agent line is bold (wider glyphs)
// so it gets a slightly tighter budget than the project line.
const AGENT_MAX = 10;
const PROJECT_MAX = 12;

const FONT = "Helvetica, Arial, sans-serif";

export function projectLabel(cwd: string): string {
	if (!cwd) return "";
	const parts = cwd.split(/[/\\]/).filter(Boolean);
	return parts[parts.length - 1] ?? "";
}

/**
 * Escapes the five XML metacharacters. Agent names and project directory names
 * are interpolated straight into the icon SVG (see `label`), and a name
 * containing `&`, `<`, `>` etc. would otherwise produce malformed XML that the
 * Stream Deck image renderer rejects - blanking the key. This is not cosmetic:
 * a cwd like `~/work/a&b` is perfectly legal on disk.
 */
export function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => {
		switch (char) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&apos;";
		}
	});
}

/**
 * Clamps a label to `max` characters, middle-truncating with a single-glyph
 * ellipsis when it is too long - so both ends survive (`claude-control-streamdeck`
 * -> `claude…mdeck`). SVG `<text>` neither wraps nor clips on its own, so without
 * this an over-long name would just render off the edge of the 72px key. The
 * ellipsis counts toward `max`, so the result is never wider than an
 * un-truncated `max`-character string. Keeping the tail matters because a
 * project's distinguishing part is often at the end (`app-web` vs `app-api`),
 * which a tail-only truncation would hide.
 */
export function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	if (max <= 1) return value.slice(0, max);
	const keep = max - 1; // one glyph spent on the ellipsis
	const head = Math.ceil(keep / 2);
	const tail = keep - head;
	return `${value.slice(0, head)}…${tail > 0 ? value.slice(value.length - tail) : ""}`;
}

/**
 * Whether a `#rrggbb` background is light enough that dark text reads better on
 * it than white. Uses the standard perceived-luminance weighting (green
 * dominates human brightness perception). The status palette's amber "working"
 * color is the one that crosses the threshold - white text on it was hard to
 * read; everything else (green/red/grey and the dark reserved/disconnected
 * backgrounds) stays below it and keeps white text. Anything unparseable is
 * treated as dark, the safe default for the mostly-dark palette.
 */
export function isLightColor(hex: string): boolean {
	const match = /^#?([0-9a-f]{6})$/i.exec(hex);
	if (!match) return false;
	const int = Number.parseInt(match[1], 16);
	const r = (int >> 16) & 0xff;
	const g = (int >> 8) & 0xff;
	const b = int & 0xff;
	return 0.299 * r + 0.587 * g + 0.114 * b > 140;
}

function background(render: SlotRender, pulseOn: boolean): string {
	switch (render.kind) {
		case "agent":
			if (render.status === "blocked" && !pulseOn) return "#7a1f22";
			return COLORS[render.status] ?? COLORS.unknown;
		case "unclaimed":
			return UNCLAIMED_COLOR;
		case "disconnected":
			return DISCONNECTED_COLOR;
	}
}

function line(text: string, max: number, y: number, size: number, weight: number, fill: string, halo: string): string {
	const safe = escapeXml(truncate(text, max));
	// paint-order="stroke" draws a thin halo behind the glyphs first, so the text
	// keeps an edge against the fill color. The halo contrasts with the TEXT (a
	// dark halo behind white text, a light halo behind dark text), so it helps
	// rather than muddies. An SVG renderer that ignores the attribute simply
	// draws plain fill - no harm done.
	return `<text x="36" y="${y}" text-anchor="middle" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" stroke="${halo}" stroke-width="0.6" paint-order="stroke">${safe}</text>`;
}

const DARK_HALO = "#00000059";
const LIGHT_HALO = "#ffffff73";

// The identifying text drawn INSIDE the key image. This replaces the Stream
// Deck key title entirely (see AgentSlotAction.renderAll, which now clears the
// title) so each key is self-contained: agent name over project for a live
// agent, the project alone for a reserved slot, and an explicit label for the
// disconnected state. `unclaimed` stays deliberately blank.
function label(render: SlotRender): string {
	switch (render.kind) {
		case "agent": {
			// Text color is chosen from the status color (not the possibly-dimmed
			// pulse background - blocked stays dark in both pulse states), so the
			// light amber "working" background gets dark, legible text while the
			// darker statuses keep white.
			const light = isLightColor(COLORS[render.status] ?? COLORS.unknown);
			const primary = light ? "#141414" : "#ffffff";
			const secondary = light ? "#333333" : "#f0f0f0";
			const halo = light ? LIGHT_HALO : DARK_HALO;
			return `${line(render.agent, AGENT_MAX, 32, 13, 600, primary, halo)}
	${line(render.project, PROJECT_MAX, 50, 11, 400, secondary, halo)}`;
		}
		case "disconnected":
			return line("no herdr", 12, 62, 11, 500, "#e5a0a0", DARK_HALO);
		case "unclaimed":
			return "";
	}
}

// A small status badge in the top-right corner, so status is legible by SHAPE
// and not colour alone (working=spinner ring, idle=dot, blocked="!"). The
// disconnected state keeps its full-size X. `unknown` gets no badge — there is
// no meaningful shape for it, and the grey background already reads as "no
// status". blockedBadge()/disconnectedGlyph() are byte-identical to the shapes
// that used to live here inline, so those two states render unchanged.
function glyph(render: SlotRender): string {
	if (render.kind === "disconnected") return disconnectedGlyph();
	if (render.kind !== "agent") return "";
	switch (render.status) {
		case "blocked":
			return blockedBadge();
		case "working":
			return workingBadge();
		case "idle":
			return idleBadge();
		default:
			return "";
	}
}

export function slotImage(render: SlotRender, pulseOn: boolean): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
	<rect width="72" height="72" rx="8" fill="${background(render, pulseOn)}"/>
	${label(render)}
	${glyph(render)}
</svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
