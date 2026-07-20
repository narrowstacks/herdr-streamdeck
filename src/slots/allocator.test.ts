import { describe, expect, it } from "vitest";
import { SlotAllocator } from "./allocator.js";

describe("SlotAllocator", () => {
	it("assigns the lowest registered free slot to a new cwd", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(2);
		allocator.registerSlot(0);
		allocator.registerSlot(1);

		expect(allocator.claim("/work/dorkroom")).toBe(0);
		expect(allocator.claim("/work/negpy")).toBe(1);
		expect(allocator.claim("/work/hmpc")).toBe(2);
	});

	it("returns the same slot when the same cwd is claimed again", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.registerSlot(1);

		expect(allocator.claim("/work/dorkroom")).toBe(0);
		expect(allocator.claim("/work/dorkroom")).toBe(0);
	});

	it("keeps a slot reserved for a cwd whose agent has exited", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.registerSlot(1);
		allocator.claim("/work/dorkroom");
		allocator.claim("/work/negpy");

		// negpy's agent exits — nothing is released. A new project must not take slot 1.
		expect(allocator.claim("/work/stenobar")).toBeUndefined();
		expect(allocator.cwdForSlot(1)).toBe("/work/negpy");
	});

	it("returns the original slot when a cwd reappears after its agent exited", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.registerSlot(1);
		allocator.claim("/work/dorkroom");
		allocator.claim("/work/negpy");

		expect(allocator.claim("/work/negpy")).toBe(1);
	});

	it("returns undefined when every registered slot is taken", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.claim("/work/dorkroom");

		expect(allocator.claim("/work/negpy")).toBeUndefined();
	});

	it("cannot claim a slot that is not registered", () => {
		const allocator = new SlotAllocator();

		expect(allocator.claim("/work/dorkroom")).toBeUndefined();
	});

	it("round-trips assignments through toJSON and the constructor", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.registerSlot(1);
		allocator.claim("/work/dorkroom");
		allocator.claim("/work/negpy");

		const restored = new SlotAllocator(allocator.toJSON());
		restored.registerSlot(0);
		restored.registerSlot(1);

		expect(restored.slotForCwd("/work/negpy")).toBe(1);
		expect(restored.cwdForSlot(0)).toBe("/work/dorkroom");
	});

	it("keeps assignments for slots that are no longer registered", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.claim("/work/dorkroom");
		allocator.unregisterSlot(0);

		expect(allocator.slotForCwd("/work/dorkroom")).toBe(0);
	});
});
