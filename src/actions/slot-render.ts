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
	getByCwd(cwd: string): AgentInfo | undefined;
}

/**
 * Claims a slot for every currently-known agent whose cwd doesn't have one
 * yet. Finding 2/3: this used to re-run, from scratch, once per key inside
 * the render loop (`renderFor` was called once per key by `renderAll`) - an
 * O(agents) scan repeated O(keys) times per pass for no benefit, since the
 * outcome does not depend on which key is being rendered. It is now called
 * once per `renderAll()` pass; the caller decides whether the `claimed`
 * result warrants a persistence write.
 *
 * Safety property: a disconnected registry claims nothing - claiming while
 * disconnected could reserve slots against stale/unconfirmed agent data.
 */
export function claimUnassignedAgents(registry: RegistrySnapshot, alloc: SlotAllocator): boolean {
	if (!registry.connected) return false;
	let claimed = false;
	for (const agent of registry.agents) {
		if (alloc.slotForCwd(agent.cwd) === undefined) {
			if (alloc.claim(agent.cwd) !== undefined) claimed = true;
		}
	}
	return claimed;
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
 */
export function slotRenderFor(registry: RegistrySnapshot, alloc: SlotAllocator, slotIndex: number): SlotRender {
	if (!registry.connected) return { kind: "disconnected" };

	const cwd = alloc.cwdForSlot(slotIndex);
	if (!cwd) return { kind: "unclaimed" };

	const agent = registry.getByCwd(cwd);
	if (!agent) return { kind: "reserved", project: projectLabel(cwd) };

	return {
		kind: "agent",
		status: agent.status,
		agent: agent.agent,
		project: projectLabel(agent.cwd),
	};
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
