import type { SlotAllocatorState } from "./allocator.js";

export interface SlotStateLoadResult {
	state: SlotAllocatorState;
	warnings: string[];
}

function isValidSlotIndex(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Turns whatever `SlotAllocator.toJSON()` output was persisted into Stream
 * Deck global settings (and read back as arbitrary JSON) into a trustworthy
 * `SlotAllocatorState`, never throwing.
 *
 * `SlotAllocator` itself does no validation of constructor-supplied state
 * (it stays a pure, synchronously-testable object) — this is the guard the
 * loader applies before handing state to it. Global settings can be
 * malformed in ways a hand-rolled JSON blob can be: not an object at all, an
 * `assignments` map with non-numeric or negative/fractional values, or —
 * the case that would otherwise corrupt allocator invariants — two cwds
 * mapped to the same slot index. In that last case the first entry
 * (object key order) wins and the rest are dropped, so no two live
 * assignments can ever collide on one slot.
 */
export function sanitizeSlotAllocatorState(raw: unknown): SlotStateLoadResult {
	const warnings: string[] = [];

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warnings.push("persisted slot state is not a JSON object; starting with no restored assignments");
		return { state: { assignments: {} }, warnings };
	}

	const assignmentsRaw = (raw as { assignments?: unknown }).assignments;
	if (typeof assignmentsRaw !== "object" || assignmentsRaw === null || Array.isArray(assignmentsRaw)) {
		warnings.push(
			"persisted slot state has no valid 'assignments' object; starting with no restored assignments",
		);
		return { state: { assignments: {} }, warnings };
	}

	const assignments: Record<string, number> = {};
	const usedSlots = new Set<number>();
	for (const [cwd, value] of Object.entries(assignmentsRaw as Record<string, unknown>)) {
		if (cwd.length === 0) {
			warnings.push("persisted slot state has an empty cwd key; dropped");
			continue;
		}
		if (!isValidSlotIndex(value)) {
			warnings.push(`persisted slot state entry "${cwd}" has an invalid slot index; dropped`);
			continue;
		}
		if (usedSlots.has(value)) {
			warnings.push(
				`persisted slot state maps both an earlier cwd and "${cwd}" to slot ${value}; keeping the first, dropping "${cwd}"`,
			);
			continue;
		}
		usedSlots.add(value);
		assignments[cwd] = value;
	}

	return { state: { assignments }, warnings };
}
