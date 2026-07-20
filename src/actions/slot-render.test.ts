import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../herdr/types.js";
import { SlotAllocator } from "../slots/allocator.js";
import { claimUnassignedAgents, hasBlockedAgent, slotRenderFor } from "./slot-render.js";

function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
	return {
		paneId: "w1-1",
		agent: "claude",
		status: "blocked",
		cwd: "/work/dorkroom",
		focused: false,
		workspaceId: "w1",
		...overrides,
	};
}

/** A minimal fake satisfying RegistrySnapshot without pulling in AgentRegistry/HerdrClient. */
function fakeRegistry(connected: boolean, agents: AgentInfo[]) {
	return {
		connected,
		agents,
		getByCwd: (cwd: string) => agents.find((a) => a.cwd === cwd),
	};
}

describe("slotRenderFor", () => {
	it("SAFETY: yields disconnected whenever the registry is disconnected, never a live-looking render", () => {
		// The one property this whole plugin cannot regress: a key must never
		// show green (or any agent color) while the underlying data isn't
		// trusted fresh. Exercise this with agent data present and even
		// matching an assigned slot, to prove the disconnected check really is
		// checked first and unconditionally, not just true in the empty case.
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		alloc.claim("/work/dorkroom");

		const registry = fakeRegistry(false, [agent({ status: "idle" })]);
		expect(slotRenderFor(registry, alloc, 0)).toEqual({ kind: "disconnected" });
	});

	it("yields unclaimed for a registered slot with no assignment", () => {
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		const registry = fakeRegistry(true, []);
		expect(slotRenderFor(registry, alloc, 0)).toEqual({ kind: "unclaimed" });
	});

	it("yields reserved when a slot's cwd has no live agent", () => {
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		alloc.claim("/work/dorkroom");
		const registry = fakeRegistry(true, []);
		expect(slotRenderFor(registry, alloc, 0)).toEqual({ kind: "reserved", project: "dorkroom" });
	});

	it("yields agent for a slot whose cwd has a live agent", () => {
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		alloc.claim("/work/dorkroom");
		const registry = fakeRegistry(true, [agent({ status: "working" })]);
		expect(slotRenderFor(registry, alloc, 0)).toEqual({
			kind: "agent",
			status: "working",
			agent: "claude",
			project: "dorkroom",
		});
	});

	it("does not claim on the caller's behalf - a live agent with no assigned slot renders unclaimed for every slot", () => {
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		const registry = fakeRegistry(true, [agent()]);
		expect(slotRenderFor(registry, alloc, 0)).toEqual({ kind: "unclaimed" });
	});
});

describe("claimUnassignedAgents", () => {
	it("claims a slot for every agent whose cwd has none yet", () => {
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		alloc.registerSlot(1);
		const registry = fakeRegistry(true, [
			agent({ cwd: "/work/dorkroom" }),
			agent({ cwd: "/work/negpy", paneId: "w1-2" }),
		]);

		expect(claimUnassignedAgents(registry, alloc)).toBe(true);
		expect(alloc.slotForCwd("/work/dorkroom")).toBe(0);
		expect(alloc.slotForCwd("/work/negpy")).toBe(1);
	});

	it("returns false when every known agent already has a slot", () => {
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		alloc.claim("/work/dorkroom");
		const registry = fakeRegistry(true, [agent({ cwd: "/work/dorkroom" })]);

		expect(claimUnassignedAgents(registry, alloc)).toBe(false);
	});

	it("returns false and claims nothing while disconnected", () => {
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		const registry = fakeRegistry(false, [agent({ cwd: "/work/dorkroom" })]);

		expect(claimUnassignedAgents(registry, alloc)).toBe(false);
		expect(alloc.slotForCwd("/work/dorkroom")).toBeUndefined();
	});
});

describe("hasBlockedAgent", () => {
	it("is true when at least one agent is blocked", () => {
		expect(hasBlockedAgent([agent({ status: "working" }), agent({ status: "blocked" })])).toBe(true);
	});

	it("is false when no agent is blocked", () => {
		expect(hasBlockedAgent([agent({ status: "working" }), agent({ status: "idle" })])).toBe(false);
	});

	it("is false for an empty agent list", () => {
		expect(hasBlockedAgent([])).toBe(false);
	});
});
