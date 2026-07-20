export interface SlotAllocatorState {
	assignments: Record<string, number>;
}

export class SlotAllocator {
	private readonly assignments: Map<string, number>;
	private readonly registered = new Set<number>();

	constructor(state?: SlotAllocatorState) {
		this.assignments = new Map(Object.entries(state?.assignments ?? {}));
	}

	registerSlot(slotIndex: number): void {
		this.registered.add(slotIndex);
	}

	unregisterSlot(slotIndex: number): void {
		this.registered.delete(slotIndex);
	}

	claim(cwd: string): number | undefined {
		const existing = this.assignments.get(cwd);
		if (existing !== undefined) return existing;

		const taken = new Set(this.assignments.values());
		const free = [...this.registered].filter((i) => !taken.has(i)).sort((a, b) => a - b);
		const slot = free[0];
		if (slot === undefined) return undefined;

		this.assignments.set(cwd, slot);
		return slot;
	}

	slotForCwd(cwd: string): number | undefined {
		return this.assignments.get(cwd);
	}

	cwdForSlot(slotIndex: number): string | undefined {
		for (const [cwd, index] of this.assignments) {
			if (index === slotIndex) return cwd;
		}
		return undefined;
	}

	toJSON(): SlotAllocatorState {
		return { assignments: Object.fromEntries(this.assignments) };
	}
}
