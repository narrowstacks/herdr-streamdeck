import { describe, expect, it } from "vitest";
import type { ApprovalDecision } from "./approval.js";
import { approvalImage, approvalKeyState } from "./approval-render.js";

function decodeSvg(image: string): string {
	return Buffer.from(image.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
}

describe("approvalKeyState", () => {
	it("maps an ok decision to armed", () => {
		const decision: ApprovalDecision = { ok: true, paneId: "w1-1", keys: ["y"] };
		expect(approvalKeyState(decision)).toBe("armed");
	});

	it("maps a disconnected decision to disconnected", () => {
		expect(approvalKeyState({ ok: false, reason: "disconnected" })).toBe("disconnected");
	});

	it.each(["no-focused-agent", "not-blocked", "invalid-pane", "empty-keys"] as const)(
		"maps reason %s to disarmed",
		(reason) => {
			expect(approvalKeyState({ ok: false, reason })).toBe("disarmed");
		},
	);
});

describe("approvalImage", () => {
	it("returns an SVG data URI", () => {
		expect(approvalImage("approve", "armed")).toMatch(/^data:image\/svg\+xml;base64,/);
	});

	it("armed approve carries the checkmark path on a vivid green background and no opacity group", () => {
		const svg = decodeSvg(approvalImage("approve", "armed"));
		expect(svg).toContain("M22 37");
		expect(svg).toContain("#30a46c");
		expect(svg).not.toContain("opacity=");
	});

	it("disarmed approve dims the glyph with an opacity group", () => {
		const svg = decodeSvg(approvalImage("approve", "disarmed"));
		expect(svg).toContain('opacity="0.34"');
	});

	it("approve and deny render differently for the same state, and deny carries the X path", () => {
		expect(approvalImage("approve", "armed")).not.toBe(approvalImage("deny", "armed"));
		const denySvg = decodeSvg(approvalImage("deny", "armed"));
		expect(denySvg).toContain("M25 25");
	});

	it("disconnected uses the neutral background", () => {
		const svg = decodeSvg(approvalImage("approve", "disconnected"));
		expect(svg).toContain("#26262b");
	});
});
