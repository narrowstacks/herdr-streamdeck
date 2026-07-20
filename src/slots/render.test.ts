import { describe, expect, it } from "vitest";
import type { AgentStatus } from "../herdr/types.js";
import { projectLabel, slotImage, slotTitle } from "./render.js";

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

describe("slotTitle", () => {
	it("shows agent and project for an active agent", () => {
		expect(slotTitle({ kind: "agent", status: "blocked", agent: "claude", project: "dorkroom" })).toBe(
			"claude\ndorkroom",
		);
	});

	it("shows the project for a reserved slot", () => {
		expect(slotTitle({ kind: "reserved", project: "negpy" })).toBe("negpy");
	});

	it("shows nothing for an unclaimed slot", () => {
		expect(slotTitle({ kind: "unclaimed" })).toBe("");
	});

	it("names the disconnected state explicitly rather than looking idle", () => {
		expect(slotTitle({ kind: "disconnected" })).toBe("no herdr");
	});
});

describe("slotImage", () => {
	it("returns an svg data uri", () => {
		const image = slotImage({ kind: "unclaimed" }, false);
		expect(image.startsWith("data:image/svg+xml;base64,")).toBe(true);
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
		const svg = Buffer.from(image.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
		expect(svg).not.toContain("undefined");
		expect(svg).toContain('fill="#6f6f6f"');
	});
});
