import streamDeck, {
	action,
	SingletonAction,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type WillAppearEvent,
	type WillDisappearEvent,
	type KeyDownEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { registry, allocator, saveSlots, client } from "../plugin-state.js";
import { slotImage, slotTitle } from "../slots/render.js";
import { claimUnassignedAgents, hasBlockedAgent, slotRenderFor } from "./slot-render.js";

// The explicit index signature (rather than `unknown`) is required for this
// to satisfy the SDK's `T extends JsonObject` constraint on actions/events -
// settings round-trip through Stream Deck as JSON, so `unknown` (which
// admits non-JSON values like functions) isn't actually a valid settings
// shape.
export interface AgentSlotSettings {
	slotIndex?: number;
	[key: string]: JsonValue | undefined;
}

const PULSE_MS = 500;

@action({ UUID: "com.aaronfa.herdr-agents.slot" })
export class AgentSlotAction extends SingletonAction<AgentSlotSettings> {
	private pulseOn = false;
	private pulseTimer?: NodeJS.Timeout;

	// Finding 3: `slotIndex` is cached here (keyed by the SDK's per-instance
	// `action.id`) from `onWillAppear`/`onDidReceiveSettings`, rather than
	// re-fetched via `key.getSettings()` on every render. With the SDK's
	// `useExperimentalMessageIdentifiers` off (the default, and unchanged by
	// this fix), `getSettings()` is a real getSettings/didReceiveSettings
	// websocket round trip, not a cache read - `renderAll()` used to make one
	// per key, every 500ms, forever, via the pulse timer alone.
	private readonly slotIndexByActionId = new Map<string, number>();

	constructor() {
		super();
		// Finding 1: this listener runs whenever AgentRegistry emits
		// "changed" - a plain EventEmitter callback, not something any
		// caller awaits. Before this fix, `void this.renderAll()` let any
		// rejection (renderAll awaits key.getSettings()/setImage()/
		// setTitle(), any of which can reject) surface as an unhandled
		// rejection, which under Node >=20 defaults to terminating the
		// process - blanking every key. Every fire-and-forget call site in
		// this class now routes its rejection to logRenderFailure/
		// logSaveFailure instead.
		registry.on("changed", () => {
			this.renderAll().catch((err: unknown) => this.logRenderFailure(err));
		});
	}

	override async onWillAppear(ev: WillAppearEvent<AgentSlotSettings>): Promise<void> {
		const slotIndex = ev.payload.settings.slotIndex ?? 0;
		this.slotIndexByActionId.set(ev.action.id, slotIndex);
		allocator().registerSlot(slotIndex);
		this.ensurePulse();
		await this.renderAll();
	}

	// Keeps the cached slotIndex (see the class-level comment) in sync if the
	// property inspector changes it while the key is visible - without this,
	// caching slotIndex would mean a settings change silently stops being
	// reflected until the next willAppear (e.g. a profile switch).
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<AgentSlotSettings>): Promise<void> {
		const slotIndex = ev.payload.settings.slotIndex ?? 0;
		this.slotIndexByActionId.set(ev.action.id, slotIndex);
		await this.renderAll();
	}

	override async onWillDisappear(ev: WillDisappearEvent<AgentSlotSettings>): Promise<void> {
		const slotIndex = ev.payload.settings.slotIndex ?? 0;
		allocator().unregisterSlot(slotIndex);
		this.slotIndexByActionId.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPulse();
	}

	override async onKeyDown(ev: KeyDownEvent<AgentSlotSettings>): Promise<void> {
		const slotIndex = ev.payload.settings.slotIndex ?? 0;
		const render = slotRenderFor(registry, allocator(), slotIndex);
		if (render.kind !== "agent") {
			await ev.action.showAlert();
			return;
		}
		const cwd = allocator().cwdForSlot(slotIndex);
		const agent = cwd ? registry.getByCwd(cwd) : undefined;
		if (!agent) {
			await ev.action.showAlert();
			return;
		}
		try {
			await client.request("agent.focus", { target: agent.paneId });
		} catch {
			await ev.action.showAlert();
		}
	}

	private ensurePulse(): void {
		if (this.pulseTimer) return;
		this.pulseTimer = setInterval(() => {
			// Finding 3: skip the repaint (and the websocket round trips it
			// costs, one setImage+setTitle per key) when nothing is blocked -
			// pulseOn only ever changes a blocked key's background, so with
			// no agent blocked a tick here cannot change a single pixel.
			if (!hasBlockedAgent(registry.agents)) return;
			this.pulseOn = !this.pulseOn;
			this.renderAll().catch((err: unknown) => this.logRenderFailure(err));
		}, PULSE_MS);
	}

	private stopPulse(): void {
		if (this.pulseTimer) clearInterval(this.pulseTimer);
		this.pulseTimer = undefined;
	}

	private async renderAll(): Promise<void> {
		// Finding 2/3: claiming is hoisted out of the per-key loop below and
		// done once per renderAll() pass (see claimUnassignedAgents' own
		// comment). saveSlots() itself now serializes/coalesces overlapping
		// calls (see plugin-state.ts), but calling it at most once here,
		// rather than once per key, removes most of the burst to begin with.
		const claimed = claimUnassignedAgents(registry, allocator());
		if (claimed) {
			saveSlots().catch((err: unknown) => this.logSaveFailure(err));
		}

		for (const instance of this.actions) {
			if (!instance.isKey()) continue;
			const key = instance as KeyAction<AgentSlotSettings>;
			const slotIndex = this.slotIndexByActionId.get(key.id) ?? 0;
			const render = slotRenderFor(registry, allocator(), slotIndex);
			await key.setImage(slotImage(render, this.pulseOn));
			await key.setTitle(slotTitle(render));
		}
	}

	private logRenderFailure(err: unknown): void {
		streamDeck.logger.error("agent-slot: renderAll failed", err);
	}

	private logSaveFailure(err: unknown): void {
		streamDeck.logger.error("agent-slot: saveSlots failed", err);
	}
}
