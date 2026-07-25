import type { AgentInfo } from "../herdr/types.js";
import type { SlotAllocator } from "../slots/allocator.js";
import { projectLabel, type SlotRender } from "../slots/render.js";

/**
 * The minimal read surface `AgentSlotAction` needs from `AgentRegistry`,
 * extracted as a structural interface (rather than depending on the concrete
 * class) so the decision functions below can be exercised in a fast,
 * SDK-free unit test with a plain object literal - not because the registry
 * shape itself is expected to vary. `AgentRegistry` already satisfies this
 * structurally; no change to it was needed or made.
 */
export interface RegistrySnapshot {
	readonly connected: boolean;
	readonly agents: readonly AgentInfo[];
	getByPaneId(paneId: string): AgentInfo | undefined;
}

/**
 * Brings the allocator's first-seen agent order in line with the live agent
 * set (see SlotAllocator.syncAgents): newly-appeared agents are appended,
 * departed ones drop out, and the allocator packs whatever remains into the
 * registered slots with no gaps. Agents are keyed by `pane_id`, not cwd, so two
 * agents sharing a directory (e.g. a claude and a codex in the same repo) each
 * get their own key.
 *
 * Returns whether the ordered set changed, so the caller can decide whether the
 * result warrants a persistence write.
 *
 * Safety property: a disconnected registry changes nothing - its agent list is
 * untrusted/stale, so syncing against it (which would drop every "missing"
 * agent) is not safe. The existing order is preserved until real data returns.
 */
export function reconcileSlotAssignments(registry: RegistrySnapshot, alloc: SlotAllocator): boolean {
	if (!registry.connected) return false;
	return alloc.syncAgents(registry.agents.map((agent) => agent.paneId));
}

/**
 * Decides what a single slot should show.
 *
 * Safety property (must never regress): a disconnected registry always
 * yields `disconnected`, checked first and unconditionally - no branch below
 * it ever runs against a `connected: false` registry, so a key can never
 * show live-looking agent data while the registry itself doesn't trust its
 * own data freshness (see `AgentRegistry.connected`'s own doc comment for
 * why `connected` alone, not just a live socket, is what that means).
 *
 * An assigned slot whose pane has no live agent renders `unclaimed` (blank):
 * under pane-id keying a gone pane is gone for good, and
 * `reconcileSlotAssignments` releases it before the next render anyway, so
 * there is no persistent "reserved" state to show.
 */
export function slotRenderFor(registry: RegistrySnapshot, alloc: SlotAllocator, slotIndex: number): SlotRender {
	if (!registry.connected) return { kind: "disconnected" };

	const paneId = alloc.paneIdForSlot(slotIndex);
	if (!paneId) return { kind: "unclaimed" };

	const agent = registry.getByPaneId(paneId);
	if (!agent) return { kind: "unclaimed" };

	return {
		kind: "agent",
		status: agent.status,
		agent: agent.agent,
		project: projectLabel(agent.cwd),
	};
}

export interface SlotSelectItem {
	label: string;
	value: string;
}

/**
 * Builds the label/value list for the property inspector's slot picker (see
 * ui/agent-slot.html's `datasource="getSlots"`), so the dropdown reads
 * "3: codex · stenobar" instead of a bare "3" - you can tell which agent each
 * slot currently holds without guessing.
 *
 * Always returns exactly `count` items (values "0".."count-1" as strings, since
 * the setting round-trips through the PI as a string), independent of the herdr
 * connection - the slot list itself must stay selectable even when nothing is
 * running. Only the agent/directory annotation depends on live data: a
 * disconnected registry (whose agent list isn't trusted) shows plain numbers.
 */
export function slotSelectItems(registry: RegistrySnapshot, alloc: SlotAllocator, count: number): SlotSelectItem[] {
	const items: SlotSelectItem[] = [];
	for (let i = 0; i < count; i++) {
		const paneId = registry.connected ? alloc.paneIdForSlot(i) : undefined;
		const agent = paneId ? registry.getByPaneId(paneId) : undefined;
		const label = agent ? `${i + 1}: ${agent.agent} · ${projectLabel(agent.cwd)}` : `${i + 1}`;
		items.push({ label, value: String(i) });
	}
	return items;
}

/**
 * True when at least one known agent is blocked. Finding 3: the pulse timer
 * used to unconditionally re-render every key, every 500ms, forever, even
 * though `pulseOn` only ever changes what a *blocked* key's background looks
 * like (see `slots/render.ts`'s `background()`) - with nothing blocked, a
 * pulse tick cannot change a single pixel, so doing it anyway was pure
 * websocket round-trip cost for zero visible effect. Gating the pulse tick's
 * render on this leaves the "changed" listener (real state transitions) as
 * the only other render trigger, which is unaffected by this gate.
 */
export function hasBlockedAgent(agents: readonly AgentInfo[]): boolean {
	return agents.some((agent) => agent.status === "blocked");
}
