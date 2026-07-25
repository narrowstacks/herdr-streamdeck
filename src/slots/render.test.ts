import { describe, expect, it } from "vitest";
import type { AgentStatus } from "../herdr/types.js";
import { escapeXml, isLightColor, projectLabel, slotImage, truncate } from "./render.js";

function decodeSvg(image: string): string {
	return Buffer.from(image.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
}

describe("projectLabel", () => {
	it("uses the basename of the cwd", () => {
		expect(projectLabel("/Users/aaron/workspace/dorkroom")).toBe("dorkroom");
	});

	it("returns an empty string for an empty cwd", () => {
		expect(projectLabel("")).toBe("");
	});

	it("ignores a trailing slash", () => {
		expect(projectLabel("/Users/aaron/workspace/dorkroom/")).toBe("dorkroom");
	});

	it("returns an empty string for the root path", () => {
		expect(projectLabel("/")).toBe("");
	});

	it("handles a relative path", () => {
		expect(projectLabel("workspace/dorkroom")).toBe("dorkroom");
	});

	it("handles a Windows-style path", () => {
		expect(projectLabel("C:\\Users\\aaron\\workspace\\dorkroom")).toBe("dorkroom");
	});
});

describe("escapeXml", () => {
	it("escapes the five XML metacharacters so a name cannot break the SVG", () => {
		expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
	});

	it("leaves ordinary text unchanged", () => {
		expect(escapeXml("dorkroom")).toBe("dorkroom");
	});
});

describe("truncate", () => {
	it("returns short strings unchanged", () => {
		expect(truncate("dorkroom", 12)).toBe("dorkroom");
	});

	it("middle-truncates an over-long string, keeping head and tail within max characters", () => {
		const result = truncate("claude-control-streamdeck", 12);
		expect(result.length).toBe(12);
		expect(result).toContain("…");
		expect(result.startsWith("claude")).toBe(true);
		expect(result.endsWith("deck")).toBe(true);
		expect(result).not.toContain("claude-control-streamdeck");
	});
});

describe("isLightColor", () => {
	it("treats the amber working background as light", () => {
		expect(isLightColor("#f5a524")).toBe(true);
	});

	it("treats the green, red, and grey backgrounds as dark", () => {
		expect(isLightColor("#30a46c")).toBe(false);
		expect(isLightColor("#e5484d")).toBe(false);
		expect(isLightColor("#6f6f6f")).toBe(false);
	});
});

describe("slotImage", () => {
	it("returns an svg data uri", () => {
		const image = slotImage({ kind: "unclaimed" }, false);
		expect(image.startsWith("data:image/svg+xml;base64,")).toBe(true);
	});

	it("renders the agent name and project inside the icon", () => {
		const svg = decodeSvg(slotImage({ kind: "agent", status: "idle", agent: "stenobar", project: "streamdeck" }, false));
		expect(svg).toContain("stenobar");
		expect(svg).toContain("streamdeck");
	});

	it("escapes special characters in a name so the svg stays well-formed", () => {
		const svg = decodeSvg(slotImage({ kind: "agent", status: "idle", agent: "a&b", project: "d" }, false));
		expect(svg).toContain("a&amp;b");
		expect(svg).not.toContain("a&b");
	});

	it("truncates a long project name so it cannot overflow the key", () => {
		const svg = decodeSvg(
			slotImage({ kind: "agent", status: "idle", agent: "claude", project: "claude-control-streamdeck" }, false),
		);
		expect(svg).not.toContain("claude-control-streamdeck");
		expect(svg).toContain("…");
	});

	it("uses dark text on the light amber working background for contrast", () => {
		const svg = decodeSvg(slotImage({ kind: "agent", status: "working", agent: "claude", project: "d" }, false));
		expect(svg).toContain('fill="#141414"');
		expect(svg).not.toContain('fill="#ffffff"');
	});

	it("uses white text on the dark green idle background", () => {
		const svg = decodeSvg(slotImage({ kind: "agent", status: "idle", agent: "claude", project: "d" }, false));
		expect(svg).toContain('fill="#ffffff"');
	});

	it("still shows the agent name when the agent is blocked", () => {
		const svg = decodeSvg(slotImage({ kind: "agent", status: "blocked", agent: "stenobar", project: "d" }, false));
		expect(svg).toContain("stenobar");
	});

	it("names the disconnected state inside the icon", () => {
		const svg = decodeSvg(slotImage({ kind: "disconnected" }, false));
		expect(svg).toContain("no herdr");
	});

	it("renders blocked differently on and off the pulse", () => {
		const on = slotImage({ kind: "agent", status: "blocked", agent: "claude", project: "d" }, true);
		const off = slotImage({ kind: "agent", status: "blocked", agent: "claude", project: "d" }, false);
		expect(on).not.toBe(off);
	});

	it("does not pulse a working agent", () => {
		const on = slotImage({ kind: "agent", status: "working", agent: "claude", project: "d" }, true);
		const off = slotImage({ kind: "agent", status: "working", agent: "claude", project: "d" }, false);
		expect(on).toBe(off);
	});

	it("renders disconnected distinctly from idle", () => {
		const disconnected = slotImage({ kind: "disconnected" }, false);
		const idle = slotImage({ kind: "agent", status: "idle", agent: "claude", project: "d" }, false);
		expect(disconnected).not.toBe(idle);
	});

	it("falls back to a defined color instead of emitting a malformed fill for an unrecognized status", () => {
		const bogusStatus = "corrupted" as unknown as AgentStatus;
		const image = slotImage({ kind: "agent", status: bogusStatus, agent: "claude", project: "d" }, false);
		const svg = decodeSvg(image);
		expect(svg).not.toContain("undefined");
		expect(svg).toContain('fill="#6f6f6f"');
	});

	it("marks a working agent with a distinct shape badge, not colour alone", () => {
		const svg = decodeSvg(slotImage({ kind: "agent", status: "working", agent: "claude", project: "d" }, false));
		expect(svg).toContain('stroke-dasharray="20 12"'); // the spinner-ring badge
	});

	it("marks an idle agent with a dot badge distinct from the working badge", () => {
		const working = decodeSvg(slotImage({ kind: "agent", status: "working", agent: "c", project: "d" }, false));
		const idle = decodeSvg(slotImage({ kind: "agent", status: "idle", agent: "c", project: "d" }, false));
		expect(idle).not.toContain('stroke-dasharray'); // idle is a solid dot, no ring
		expect(idle).toContain('r="5.5"');
		expect(idle).not.toBe(working); // distinguishable without relying on background colour
	});

	it("gives an unknown-status agent no status badge", () => {
		const svg = decodeSvg(slotImage({ kind: "agent", status: "unknown" as never, agent: "c", project: "d" }, false));
		expect(svg).not.toContain('stroke-dasharray'); // no working ring
		expect(svg).not.toContain('r="9"');             // no blocked "!" disc
	});
});
