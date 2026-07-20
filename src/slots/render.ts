import type { AgentStatus } from "../herdr/types.js";

export type SlotRender =
	| { kind: "agent"; status: AgentStatus; agent: string; project: string }
	| { kind: "reserved"; project: string }
	| { kind: "unclaimed" }
	| { kind: "disconnected" };

const COLORS: Record<AgentStatus, string> = {
	blocked: "#e5484d",
	working: "#f5a524",
	idle: "#30a46c",
	unknown: "#6f6f6f",
};

const RESERVED_COLOR = "#2a2a2a";
const UNCLAIMED_COLOR = "#111111";
const DISCONNECTED_COLOR = "#3a2a2a";

export function projectLabel(cwd: string): string {
	if (!cwd) return "";
	const parts = cwd.split(/[/\\]/).filter(Boolean);
	return parts[parts.length - 1] ?? "";
}

export function slotTitle(render: SlotRender): string {
	switch (render.kind) {
		case "agent":
			return `${render.agent}\n${render.project}`;
		case "reserved":
			return render.project;
		case "unclaimed":
			return "";
		case "disconnected":
			return "no herdr";
	}
}

function background(render: SlotRender, pulseOn: boolean): string {
	switch (render.kind) {
		case "agent":
			if (render.status === "blocked" && !pulseOn) return "#7a1f22";
			return COLORS[render.status] ?? COLORS.unknown;
		case "reserved":
			return RESERVED_COLOR;
		case "unclaimed":
			return UNCLAIMED_COLOR;
		case "disconnected":
			return DISCONNECTED_COLOR;
	}
}

function glyph(render: SlotRender): string {
	if (render.kind === "disconnected") {
		return `<line x1="24" y1="24" x2="48" y2="48" stroke="#e5484d" stroke-width="5" stroke-linecap="round"/>
		<line x1="48" y1="24" x2="24" y2="48" stroke="#e5484d" stroke-width="5" stroke-linecap="round"/>`;
	}
	if (render.kind === "agent" && render.status === "blocked") {
		return `<circle cx="36" cy="36" r="14" fill="none" stroke="#ffffff" stroke-width="4"/>
		<line x1="36" y1="28" x2="36" y2="38" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/>
		<circle cx="36" cy="45" r="2.5" fill="#ffffff"/>`;
	}
	return "";
}

export function slotImage(render: SlotRender, pulseOn: boolean): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
	<rect width="72" height="72" rx="8" fill="${background(render, pulseOn)}"/>
	${glyph(render)}
</svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
