import { describe, expect, it } from "vitest";
import { sanitizeSlotAllocatorState } from "./state.js";
import { SlotAllocator } from "./allocator.js";

describe("sanitizeSlotAllocatorState", () => {
	it("passes through a well-formed state unchanged", () => {
		const { state, warnings } = sanitizeSlotAllocatorState({
			assignments: { "/work/dorkroom": 0, "/work/negpy": 1 },
		});
		expect(state).toEqual({ assignments: { "/work/dorkroom": 0, "/work/negpy": 1 } });
		expect(warnings).toEqual([]);
	});

	it("round-trips through SlotAllocator after sanitizing", () => {
		const { state } = sanitizeSlotAllocatorState({ assignments: { "/work/dorkroom": 0 } });
		const allocator = new SlotAllocator(state);
		allocator.registerSlot(0);
		expect(allocator.slotForCwd("/work/dorkroom")).toBe(0);
	});

	it("degrades to an empty state when the input is not an object", () => {
		for (const bad of [null, 42, "nope", [1, 2, 3]]) {
			const { state, warnings } = sanitizeSlotAllocatorState(bad);
			expect(state).toEqual({ assignments: {} });
			expect(warnings.length).toBeGreaterThan(0);
		}
	});

	it("degrades to an empty state when 'assignments' is missing or the wrong shape", () => {
		for (const bad of [{}, { assignments: null }, { assignments: "nope" }, { assignments: [1, 2] }]) {
			const { state, warnings } = sanitizeSlotAllocatorState(bad);
			expect(state).toEqual({ assignments: {} });
			expect(warnings.length).toBeGreaterThan(0);
		}
	});

	it("drops an entry with a non-integer or negative slot index", () => {
		const { state, warnings } = sanitizeSlotAllocatorState({
			assignments: { "/work/a": 1.5, "/work/b": -1, "/work/c": "0", "/work/d": 2 },
		});
		expect(state).toEqual({ assignments: { "/work/d": 2 } });
		expect(warnings).toHaveLength(3);
	});

	it("drops an entry with an empty cwd key", () => {
		const { state, warnings } = sanitizeSlotAllocatorState({ assignments: { "": 0, "/work/a": 1 } });
		expect(state).toEqual({ assignments: { "/work/a": 1 } });
		expect(warnings).toHaveLength(1);
	});

	it("keeps only the first cwd when two cwds are mapped to the same slot", () => {
		const { state, warnings } = sanitizeSlotAllocatorState({
			assignments: { "/work/first": 0, "/work/second": 0 },
		});
		expect(state).toEqual({ assignments: { "/work/first": 0 } });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("/work/second");
	});

	it("never throws on deeply malformed input", () => {
		expect(() => sanitizeSlotAllocatorState(undefined)).not.toThrow();
		expect(() => sanitizeSlotAllocatorState({ assignments: { a: {}, b: [] } })).not.toThrow();
	});
});
