export interface SlotAllocatorState {
	/** Pane ids in first-seen order. See SlotAllocator. */
	order: string[];
}

/**
 * Maps herdr agents to Stream Deck slot indices by COMPACTION: the live agents,
 * kept in the order they were first seen, are packed into the registered slots
 * in ascending index order with no gaps. Slot index `sortedRegistered[k]` shows
 * the k-th agent; any trailing registered slots (more keys than agents) stay
 * empty, and any agents past the last registered slot (more agents than keys)
 * simply have no key.
 *
 * Agents are identified by herdr `pane_id`, which is unique per running agent
 * (a cwd is not - herdr runs e.g. a claude and a codex in the same directory).
 *
 * "First-seen order" is what makes this pleasant for a churn-heavy workflow: a
 * newly-appeared agent is appended after the current ones (newest last, filling
 * the next free key without moving anyone), and a departed agent just drops out
 * so the agents after it slide down one key. herdr re-reporting the same agents
 * in a different order never reshuffles keys - only appearances and departures
 * move anything.
 */
export class SlotAllocator {
	// Ref-counted set of slot indices currently shown by a visible key. Counting
	// matters because more than one lifecycle path registers/unregisters the same
	// index - a key appearing/disappearing, and a key changing its configured
	// slot via the property inspector (AgentSlotAction.onDidReceiveSettings). If
	// two keys briefly share an index, a single unregister must NOT drop it while
	// the other key still shows it.
	private readonly registered = new Map<number, number>();

	// Live agents' pane ids in first-seen order. This IS the assignment: agents
	// are packed into `sortedRegisteredSlots()` positionally, so this list plus
	// the registered set fully determines every slot's occupant. Persisted (see
	// toJSON) so positions survive a plugin restart while herdr keeps running.
	private order: string[];

	constructor(state?: SlotAllocatorState) {
		this.order = [...(state?.order ?? [])];
	}

	registerSlot(slotIndex: number): void {
		this.registered.set(slotIndex, (this.registered.get(slotIndex) ?? 0) + 1);
	}

	unregisterSlot(slotIndex: number): void {
		const count = this.registered.get(slotIndex);
		if (count === undefined) return;
		if (count <= 1) this.registered.delete(slotIndex);
		else this.registered.set(slotIndex, count - 1);
	}

	/**
	 * Reconciles the first-seen order to the current live pane set: drops panes
	 * no longer live (keeping the rest in place), then appends newly-seen ones in
	 * the order given. Returns whether the ordered set changed, so the caller can
	 * decide whether to persist.
	 */
	syncAgents(livePaneIds: string[]): boolean {
		const before = this.order;
		const liveSet = new Set(livePaneIds);
		const kept = before.filter((paneId) => liveSet.has(paneId));
		const keptSet = new Set(kept);
		const appended = livePaneIds.filter((paneId) => !keptSet.has(paneId));
		const next = [...kept, ...appended];

		const changed = next.length !== before.length || next.some((paneId, i) => paneId !== before[i]);
		this.order = next;
		return changed;
	}

	private sortedRegisteredSlots(): number[] {
		return [...this.registered.keys()].sort((a, b) => a - b);
	}

	/** The pane packed into a given slot index, or undefined if that slot isn't registered or has no agent. */
	paneIdForSlot(slotIndex: number): string | undefined {
		const position = this.sortedRegisteredSlots().indexOf(slotIndex);
		if (position < 0) return undefined;
		return this.order[position];
	}

	/** The slot index a given pane occupies, or undefined if it's unknown or packed past the last registered slot. */
	slotForPaneId(paneId: string): number | undefined {
		const position = this.order.indexOf(paneId);
		if (position < 0) return undefined;
		return this.sortedRegisteredSlots()[position];
	}

	toJSON(): SlotAllocatorState {
		return { order: [...this.order] };
	}
}
