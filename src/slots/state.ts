import type { SlotAllocatorState } from "./allocator.js";

export interface SlotStateLoadResult {
	state: SlotAllocatorState;
	warnings: string[];
}

/**
 * Turns whatever `SlotAllocator.toJSON()` output was persisted into Stream
 * Deck global settings (and read back as arbitrary JSON) into a trustworthy
 * `SlotAllocatorState`, never throwing.
 *
 * `SlotAllocator` itself does no validation of constructor-supplied state
 * (it stays a pure, synchronously-testable object) — this is the guard the
 * loader applies before handing state to it. The persisted state is the agents'
 * first-seen order: an array of herdr pane ids. Global settings can be
 * malformed in ways a hand-rolled JSON blob can be — not an object, no `order`
 * array, non-string or empty entries, or duplicate pane ids — so each of those
 * is dropped here. Duplicates would let one pane occupy two positions; the
 * first occurrence wins and the rest are dropped.
 *
 * State persisted by an older assignments-map build has no `order` array, so it
 * loads as an empty order and simply repopulates on the first connected
 * reconcile — a harmless migration.
 */
export function sanitizeSlotAllocatorState(raw: unknown): SlotStateLoadResult {
	const warnings: string[] = [];

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warnings.push("persisted slot state is not a JSON object; starting with no restored order");
		return { state: { order: [] }, warnings };
	}

	const orderRaw = (raw as { order?: unknown }).order;
	if (!Array.isArray(orderRaw)) {
		warnings.push("persisted slot state has no valid 'order' array; starting with no restored order");
		return { state: { order: [] }, warnings };
	}

	const order: string[] = [];
	const seen = new Set<string>();
	for (const entry of orderRaw) {
		if (typeof entry !== "string" || entry.length === 0) {
			warnings.push("persisted slot order has a non-string or empty pane id; dropped");
			continue;
		}
		if (seen.has(entry)) {
			warnings.push(`persisted slot order lists pane "${entry}" more than once; keeping the first, dropping the rest`);
			continue;
		}
		seen.add(entry);
		order.push(entry);
	}

	return { state: { order }, warnings };
}
