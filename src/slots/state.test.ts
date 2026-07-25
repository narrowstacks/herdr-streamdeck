import { describe, expect, it } from "vitest";
import { sanitizeSlotAllocatorState } from "./state.js";
import { SlotAllocator } from "./allocator.js";

describe("sanitizeSlotAllocatorState", () => {
	it("passes through a well-formed order unchanged", () => {
		const { state, warnings } = sanitizeSlotAllocatorState({ order: ["w1-1", "w1-2"] });
		expect(state).toEqual({ order: ["w1-1", "w1-2"] });
		expect(warnings).toEqual([]);
	});

	it("round-trips through SlotAllocator after sanitizing", () => {
		const { state } = sanitizeSlotAllocatorState({ order: ["w1-1"] });
		const allocator = new SlotAllocator(state);
		allocator.registerSlot(0);
		expect(allocator.paneIdForSlot(0)).toBe("w1-1");
	});

	it("degrades to an empty order when the input is not an object", () => {
		for (const bad of [null, 42, "nope", [1, 2, 3]]) {
			const { state, warnings } = sanitizeSlotAllocatorState(bad);
			expect(state).toEqual({ order: [] });
			expect(warnings.length).toBeGreaterThan(0);
		}
	});

	it("degrades to an empty order when 'order' is missing or the wrong shape", () => {
		for (const bad of [{}, { order: null }, { order: "nope" }, { order: 5 }]) {
			const { state, warnings } = sanitizeSlotAllocatorState(bad);
			expect(state).toEqual({ order: [] });
			expect(warnings.length).toBeGreaterThan(0);
		}
	});

	it("drops non-string or empty pane ids", () => {
		const { state, warnings } = sanitizeSlotAllocatorState({ order: ["w1-1", "", 42, null, "w1-2"] });
		expect(state).toEqual({ order: ["w1-1", "w1-2"] });
		expect(warnings).toHaveLength(3);
	});

	it("keeps only the first occurrence of a duplicated pane id", () => {
		const { state, warnings } = sanitizeSlotAllocatorState({ order: ["w1-1", "w1-2", "w1-1"] });
		expect(state).toEqual({ order: ["w1-1", "w1-2"] });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("w1-1");
	});

	it("migrates an older assignments-map blob to an empty order without throwing", () => {
		const { state, warnings } = sanitizeSlotAllocatorState({ assignments: { "/work/a": 0 } });
		expect(state).toEqual({ order: [] });
		expect(warnings.length).toBeGreaterThan(0);
	});

	it("never throws on deeply malformed input", () => {
		expect(() => sanitizeSlotAllocatorState(undefined)).not.toThrow();
		expect(() => sanitizeSlotAllocatorState({ order: [{}, []] })).not.toThrow();
	});
});
