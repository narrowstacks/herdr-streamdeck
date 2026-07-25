import { describe, expect, it } from "vitest";
import { SlotAllocator } from "./allocator.js";

describe("SlotAllocator", () => {
	it("packs agents into the lowest registered slots in first-seen order, no holes", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.registerSlot(1);
		allocator.registerSlot(2);

		allocator.syncAgents(["pane-a", "pane-b"]);

		expect(allocator.paneIdForSlot(0)).toBe("pane-a");
		expect(allocator.paneIdForSlot(1)).toBe("pane-b");
		expect(allocator.paneIdForSlot(2)).toBeUndefined(); // trailing slot stays empty
	});

	it("packs into registered slots in ascending index order even when registered out of order", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(2);
		allocator.registerSlot(0);

		allocator.syncAgents(["pane-a", "pane-b"]);

		expect(allocator.paneIdForSlot(0)).toBe("pane-a");
		expect(allocator.paneIdForSlot(2)).toBe("pane-b");
		expect(allocator.paneIdForSlot(1)).toBeUndefined(); // never registered
	});

	it("appends a newly-seen agent after the existing ones (newest last)", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.registerSlot(1);
		allocator.registerSlot(2);

		allocator.syncAgents(["pane-a", "pane-b"]);
		allocator.syncAgents(["pane-a", "pane-b", "pane-c"]);

		expect(allocator.paneIdForSlot(2)).toBe("pane-c");
	});

	it("compacts when an agent disappears: those after it slide down a slot", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.registerSlot(1);
		allocator.registerSlot(2);

		allocator.syncAgents(["pane-a", "pane-b", "pane-c"]);
		allocator.syncAgents(["pane-a", "pane-c"]); // pane-b exits

		expect(allocator.paneIdForSlot(0)).toBe("pane-a");
		expect(allocator.paneIdForSlot(1)).toBe("pane-c"); // slid down from slot 2
		expect(allocator.paneIdForSlot(2)).toBeUndefined();
	});

	it("does not reshuffle existing agents when herdr reports them in a different order", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.registerSlot(1);

		allocator.syncAgents(["pane-a", "pane-b"]);
		allocator.syncAgents(["pane-b", "pane-a"]); // same set, reordered input

		expect(allocator.paneIdForSlot(0)).toBe("pane-a"); // first-seen order preserved
		expect(allocator.paneIdForSlot(1)).toBe("pane-b");
	});

	it("gives no slot to agents beyond the number of registered slots", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);

		allocator.syncAgents(["pane-a", "pane-b"]);

		expect(allocator.slotForPaneId("pane-a")).toBe(0);
		expect(allocator.slotForPaneId("pane-b")).toBeUndefined();
		expect(allocator.paneIdForSlot(0)).toBe("pane-a");
	});

	it("reports the slot a given pane occupies", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.registerSlot(1);
		allocator.syncAgents(["pane-a", "pane-b"]);

		expect(allocator.slotForPaneId("pane-b")).toBe(1);
		expect(allocator.slotForPaneId("pane-unknown")).toBeUndefined();
	});

	it("syncAgents reports whether the ordered set changed", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);

		expect(allocator.syncAgents(["pane-a"])).toBe(true); // new agent
		expect(allocator.syncAgents(["pane-a"])).toBe(false); // unchanged
		expect(allocator.syncAgents(["pane-a", "pane-b"])).toBe(true); // added
		expect(allocator.syncAgents(["pane-b"])).toBe(true); // removed pane-a
	});

	it("drops an unregistered slot from the packing (its agent slides to the next key)", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.registerSlot(1);
		allocator.registerSlot(2);
		allocator.syncAgents(["pane-a", "pane-b", "pane-c"]);

		allocator.unregisterSlot(1); // the middle key is removed

		// Now only slots 0 and 2 are registered; the three agents pack into them,
		// so the third agent no longer has a key.
		expect(allocator.paneIdForSlot(0)).toBe("pane-a");
		expect(allocator.paneIdForSlot(2)).toBe("pane-b");
		expect(allocator.slotForPaneId("pane-c")).toBeUndefined();
	});

	it("keeps a slot registered until every key showing it is unregistered (ref-counted)", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.registerSlot(0); // two keys both show slot 0
		allocator.syncAgents(["pane-a"]);

		allocator.unregisterSlot(0); // one key removed; slot 0 still shown by the other

		expect(allocator.paneIdForSlot(0)).toBe("pane-a");
	});

	it("round-trips the first-seen order through toJSON and the constructor", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.registerSlot(1);
		allocator.syncAgents(["pane-a", "pane-b"]);

		const restored = new SlotAllocator(allocator.toJSON());
		restored.registerSlot(0);
		restored.registerSlot(1);

		expect(restored.paneIdForSlot(0)).toBe("pane-a");
		expect(restored.paneIdForSlot(1)).toBe("pane-b");
	});
});
