import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../herdr/types.js";
import { decideApproval } from "./approval.js";

const blocked: AgentInfo = {
	paneId: "w1-1",
	agent: "claude",
	status: "blocked",
	cwd: "/work/dorkroom",
	focused: true,
	workspaceId: "w1",
};

describe("decideApproval", () => {
	it("approves a blocked focused agent with its approve keys", () => {
		const decision = decideApproval({ connected: true, focused: blocked, intent: "approve" });
		expect(decision).toEqual({ ok: true, paneId: "w1-1", keys: ["Enter"] });
	});

	it("denies a blocked focused agent with its deny keys", () => {
		const decision = decideApproval({ connected: true, focused: blocked, intent: "deny" });
		expect(decision).toEqual({ ok: true, paneId: "w1-1", keys: ["Esc"] });
	});

	it("refuses when the focused agent is working, not blocked", () => {
		const decision = decideApproval({
			connected: true,
			focused: { ...blocked, status: "working" },
			intent: "approve",
		});
		expect(decision).toEqual({ ok: false, reason: "not-blocked" });
	});

	it("refuses when the focused agent is idle", () => {
		const decision = decideApproval({
			connected: true,
			focused: { ...blocked, status: "idle" },
			intent: "approve",
		});
		expect(decision).toEqual({ ok: false, reason: "not-blocked" });
	});

	it("refuses when nothing is focused", () => {
		const decision = decideApproval({ connected: true, focused: undefined, intent: "approve" });
		expect(decision).toEqual({ ok: false, reason: "no-focused-agent" });
	});

	it("refuses when herdr is disconnected, even with a stale blocked agent", () => {
		const decision = decideApproval({ connected: false, focused: blocked, intent: "approve" });
		expect(decision).toEqual({ ok: false, reason: "disconnected" });
	});

	it("honours a per-slot override", () => {
		const decision = decideApproval({
			connected: true,
			focused: blocked,
			intent: "approve",
			override: { approve: ["y"] },
		});
		expect(decision).toEqual({ ok: true, paneId: "w1-1", keys: ["y"] });
	});

	it("falls back to the default keymap for an unknown agent label", () => {
		const decision = decideApproval({
			connected: true,
			focused: { ...blocked, agent: "brand-new-cli" },
			intent: "approve",
		});
		expect(decision).toEqual({ ok: true, paneId: "w1-1", keys: ["Enter"] });
	});

	it("refuses when the focused agent's paneId is an empty string", () => {
		const decision = decideApproval({
			connected: true,
			focused: { ...blocked, paneId: "" },
			intent: "approve",
		});
		expect(decision).toEqual({ ok: false, reason: "invalid-pane" });
	});

	it("refuses when the resolved key sequence is empty", () => {
		const decision = decideApproval({
			connected: true,
			focused: blocked,
			intent: "approve",
			override: { approve: [] },
		});
		expect(decision).toEqual({ ok: false, reason: "empty-keys" });
	});

	it("refuses a status value outside the known AgentStatus variants rather than defaulting to approval", () => {
		// Simulates a malformed or future-version payload from herdr that
		// TypeScript's AgentInfo type wouldn't catch at runtime (e.g. JSON
		// parsed from the wire, where `status` is really just `string`).
		const decision = decideApproval({
			connected: true,
			focused: { ...blocked, status: "waiting-for-review" as AgentInfo["status"] },
			intent: "approve",
		});
		expect(decision).toEqual({ ok: false, reason: "not-blocked" });
	});
});
