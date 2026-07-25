import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../herdr/types.js";
import { SlotAllocator } from "../slots/allocator.js";
import { hasBlockedAgent, reconcileSlotAssignments, slotRenderFor, slotSelectItems } from "./slot-render.js";

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
		getByPaneId: (paneId: string) => agents.find((a) => a.paneId === paneId),
	};
}

describe("slotRenderFor", () => {
	it("SAFETY: yields disconnected whenever the registry is disconnected, never a live-looking render", () => {
		// The one property this whole plugin cannot regress: a key must never
		// show green (or any agent color) while the underlying data isn't
		// trusted fresh. Exercise this with agent data present and even
		// occupying the slot, to prove the disconnected check really is checked
		// first and unconditionally, not just true in the empty case.
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		alloc.syncAgents(["w1-1"]);

		const registry = fakeRegistry(false, [agent({ status: "idle" })]);
		expect(slotRenderFor(registry, alloc, 0)).toEqual({ kind: "disconnected" });
	});

	it("yields unclaimed for a registered slot with no agent packed into it", () => {
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		const registry = fakeRegistry(true, []);
		expect(slotRenderFor(registry, alloc, 0)).toEqual({ kind: "unclaimed" });
	});

	it("yields unclaimed when the slot's packed pane has no live agent", () => {
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		alloc.syncAgents(["w1-1"]);
		const registry = fakeRegistry(true, []);
		expect(slotRenderFor(registry, alloc, 0)).toEqual({ kind: "unclaimed" });
	});

	it("yields agent for a slot whose packed pane has a live agent", () => {
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		alloc.syncAgents(["w1-1"]);
		const registry = fakeRegistry(true, [agent({ status: "working" })]);
		expect(slotRenderFor(registry, alloc, 0)).toEqual({
			kind: "agent",
			status: "working",
			agent: "claude",
			project: "dorkroom",
		});
	});

	it("distinguishes two agents that share a cwd by their pane id", () => {
		// The bug this whole change fixes: a claude and a codex both in
		// /work/stenobar. Each pane gets its own slot and renders its own agent.
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		alloc.registerSlot(1);
		alloc.syncAgents(["w1-1", "w1-2"]);
		const registry = fakeRegistry(true, [
			agent({ paneId: "w1-1", agent: "claude", cwd: "/work/stenobar", status: "idle" }),
			agent({ paneId: "w1-2", agent: "codex", cwd: "/work/stenobar", status: "working" }),
		]);

		expect(slotRenderFor(registry, alloc, 0)).toMatchObject({ kind: "agent", agent: "claude", project: "stenobar" });
		expect(slotRenderFor(registry, alloc, 1)).toMatchObject({ kind: "agent", agent: "codex", project: "stenobar" });
	});

	it("does not sync on the caller's behalf - a live agent renders unclaimed until reconcile runs", () => {
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		const registry = fakeRegistry(true, [agent()]);
		expect(slotRenderFor(registry, alloc, 0)).toEqual({ kind: "unclaimed" });
	});
});

describe("reconcileSlotAssignments", () => {
	it("packs every live agent into a slot, keyed by pane id", () => {
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		alloc.registerSlot(1);
		const registry = fakeRegistry(true, [
			agent({ paneId: "w1-1", cwd: "/work/stenobar", agent: "claude" }),
			agent({ paneId: "w1-2", cwd: "/work/stenobar", agent: "codex" }),
		]);

		expect(reconcileSlotAssignments(registry, alloc)).toBe(true);
		expect(alloc.slotForPaneId("w1-1")).toBe(0);
		expect(alloc.slotForPaneId("w1-2")).toBe(1);
	});

	it("returns false when the live agent set is unchanged", () => {
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		alloc.syncAgents(["w1-1"]);
		const registry = fakeRegistry(true, [agent({ paneId: "w1-1" })]);

		expect(reconcileSlotAssignments(registry, alloc)).toBe(false);
	});

	it("compacts when an agent exits: the agent after it slides down a slot", () => {
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		alloc.registerSlot(1);
		alloc.syncAgents(["w1-1", "w1-2"]);
		// w1-1 exits; only w1-2 is live now.
		const registry = fakeRegistry(true, [agent({ paneId: "w1-2", cwd: "/work/negpy" })]);

		expect(reconcileSlotAssignments(registry, alloc)).toBe(true);
		expect(alloc.slotForPaneId("w1-1")).toBeUndefined();
		expect(alloc.slotForPaneId("w1-2")).toBe(0); // slid down from slot 1
	});

	it("appends a newly-appeared agent after the existing ones (newest last)", () => {
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		alloc.registerSlot(1);
		alloc.syncAgents(["w1-1"]);
		const registry = fakeRegistry(true, [agent({ paneId: "w1-1" }), agent({ paneId: "w1-2" })]);

		expect(reconcileSlotAssignments(registry, alloc)).toBe(true);
		expect(alloc.slotForPaneId("w1-1")).toBe(0); // unchanged
		expect(alloc.slotForPaneId("w1-2")).toBe(1); // appended
	});

	it("returns false and changes nothing while disconnected", () => {
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		alloc.syncAgents(["w1-1"]);
		const registry = fakeRegistry(false, [agent({ paneId: "w2-1" })]);

		expect(reconcileSlotAssignments(registry, alloc)).toBe(false);
		// A disconnected registry must NOT drop the existing order - its agent
		// list is untrusted, so w1-1 might still be alive.
		expect(alloc.slotForPaneId("w1-1")).toBe(0);
	});
});

describe("slotSelectItems", () => {
	it("returns one item per slot, valued by slot index as a string", () => {
		const alloc = new SlotAllocator();
		const registry = fakeRegistry(true, []);
		const items = slotSelectItems(registry, alloc, 8);
		expect(items).toHaveLength(8);
		expect(items.map((i) => i.value)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
	});

	it("labels an empty slot with just its 1-based number", () => {
		const alloc = new SlotAllocator();
		const registry = fakeRegistry(true, []);
		expect(slotSelectItems(registry, alloc, 3)[0]).toEqual({ label: "1", value: "0" });
	});

	it("labels an occupied slot with its agent and directory", () => {
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		alloc.registerSlot(1);
		alloc.syncAgents(["w1-1", "w1-2"]);
		const registry = fakeRegistry(true, [
			agent({ paneId: "w1-1", agent: "claude", cwd: "/work/stenobar" }),
			agent({ paneId: "w1-2", agent: "codex", cwd: "/work/stenobar" }),
		]);
		const items = slotSelectItems(registry, alloc, 3);
		expect(items[0].label).toBe("1: claude · stenobar");
		expect(items[1].label).toBe("2: codex · stenobar");
		expect(items[2].label).toBe("3");
	});

	it("does not show agent labels while disconnected, only plain slot numbers", () => {
		const alloc = new SlotAllocator();
		alloc.registerSlot(0);
		alloc.syncAgents(["w1-1"]);
		const registry = fakeRegistry(false, [agent({ paneId: "w1-1", agent: "claude", cwd: "/work/stenobar" })]);
		expect(slotSelectItems(registry, alloc, 2)[0]).toEqual({ label: "1", value: "0" });
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
