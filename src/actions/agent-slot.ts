import streamDeck, {
	action,
	SingletonAction,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type SendToPluginEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
	type KeyDownEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { registry, allocator, saveSlots, client } from "../plugin-state.js";
import { slotImage } from "../slots/render.js";
import { hasBlockedAgent, reconcileSlotAssignments, slotRenderFor, slotSelectItems } from "./slot-render.js";
import { detectRunningTerminalApps, raiseTerminalApp, resolveTerminalAppToRaise } from "./terminal.js";

// The explicit index signature (rather than `unknown`) is required for this
// to satisfy the SDK's `T extends JsonObject` constraint on actions/events -
// settings round-trip through Stream Deck as JSON, so `unknown` (which
// admits non-JSON values like functions) isn't actually a valid settings
// shape.
export interface AgentSlotSettings {
	slotIndex?: number;
	// Optional macOS app name (e.g. "Ghostty") to raise after a successful
	// `agent.focus`, so the terminal actually comes to the front instead of
	// just moving focus within herdr. Blank/absent (the default) means "do
	// nothing" - see `terminal.ts`'s `resolveTerminalAppToRaise` for why this
	// has to be user-configured rather than auto-detected.
	terminalApp?: string;
	[key: string]: JsonValue | undefined;
}

/** The `sendToPlugin` event name the property inspector's datasource-driven
 * terminal picker (see `ui/agent-slot.html`) sends to request the list of
 * currently-running known terminal apps. */
const GET_TERMINALS_EVENT = "getTerminals";

/** The `sendToPlugin` event name the property inspector's slot picker (see
 * `ui/agent-slot.html`) sends to request per-slot labels showing which agent
 * currently occupies each slot. */
const GET_SLOTS_EVENT = "getSlots";

/** Number of slots the property inspector offers (labelled 1..8; internal
 * indices 0..7). Must stay in sync with the option count in `ui/agent-slot.html`. */
const SLOT_COUNT = 8;

const PULSE_MS = 500;

/**
 * Reads the configured slot index off a key's settings as a non-negative
 * integer. The property inspector's `<sdpi-select>` persists `slotIndex` as a
 * STRING ("0".."7"), but the allocator, the persisted-state sanitizer
 * (slots/state.ts's isValidSlotIndex), and every render/claim path treat slot
 * indices as numbers. Coercing here, at the one boundary where settings are
 * read, keeps a string "1" from being registered/claimed/rendered as a
 * different key than a numeric 1 (which is how a slot could silently never get
 * an agent), and keeps sticky assignments numeric so they survive a restart.
 * Anything not a clean non-negative integer falls back to slot 0.
 */
function slotIndexFromSettings(settings: AgentSlotSettings): number {
	const n = Number(settings.slotIndex ?? 0);
	return Number.isInteger(n) && n >= 0 ? n : 0;
}

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
		const slotIndex = slotIndexFromSettings(ev.payload.settings);
		this.slotIndexByActionId.set(ev.action.id, slotIndex);
		allocator().registerSlot(slotIndex);
		this.ensurePulse();
		await this.renderAll();
	}

	// Keeps the cached slotIndex (see the class-level comment) in sync if the
	// property inspector changes it while the key is visible - without this,
	// caching slotIndex would mean a settings change silently stops being
	// reflected until the next willAppear (e.g. a profile switch).
	//
	// Crucially, a settings change must also update the allocator's registered
	// slot set: a slotIndex change is the ONLY signal that this key now
	// occupies a different slot (there is no willAppear for it), and
	// reconcileSlotAssignments can only assign an agent to a slot that is
	// registered. Without registering the new slot here, changing a key's slot
	// in the property inspector left that slot permanently unclaimable - it
	// rendered "unclaimed" and pressing it showed the alert triangle, even with
	// live agents available. Unregister the old slot too, so an agent is never
	// stranded on a slot no visible key shows any more.
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<AgentSlotSettings>): Promise<void> {
		const slotIndex = slotIndexFromSettings(ev.payload.settings);
		const previous = this.slotIndexByActionId.get(ev.action.id);
		if (previous !== slotIndex) {
			if (previous !== undefined) allocator().unregisterSlot(previous);
			allocator().registerSlot(slotIndex);
		}
		this.slotIndexByActionId.set(ev.action.id, slotIndex);
		await this.renderAll();
	}

	override async onWillDisappear(ev: WillDisappearEvent<AgentSlotSettings>): Promise<void> {
		// Unregister the slot this key was actually registered under (the cached
		// value), not a re-read of settings: onDidReceiveSettings may have moved
		// it since willAppear, and unregistering a stale settings value would
		// leave the real one registered forever (and drop the wrong ref count).
		const slotIndex = this.slotIndexByActionId.get(ev.action.id) ?? slotIndexFromSettings(ev.payload.settings);
		allocator().unregisterSlot(slotIndex);
		this.slotIndexByActionId.delete(ev.action.id);
		if (this.actions.length === 0) this.stopPulse();
	}

	override async onKeyDown(ev: KeyDownEvent<AgentSlotSettings>): Promise<void> {
		const slotIndex = slotIndexFromSettings(ev.payload.settings);
		const render = slotRenderFor(registry, allocator(), slotIndex);
		if (render.kind !== "agent") {
			await ev.action.showAlert();
			return;
		}
		const paneId = allocator().paneIdForSlot(slotIndex);
		const agent = paneId ? registry.getByPaneId(paneId) : undefined;
		if (!agent) {
			await ev.action.showAlert();
			return;
		}
		try {
			await client.request("agent.focus", { target: agent.paneId });
		} catch {
			await ev.action.showAlert();
			return;
		}

		// Raising a terminal app is a nicety layered on top of the primary
		// action above, which has already succeeded by this point. Per the
		// project's non-negotiable failure-handling rule (see
		// `logRaiseFailure`'s doc comment), a failure here must not undo or
		// mask that success: no `showAlert()`, no rethrow, just a log line.
		const terminalApp = resolveTerminalAppToRaise(ev.payload.settings.terminalApp);
		if (terminalApp) {
			try {
				await raiseTerminalApp(terminalApp);
			} catch (err) {
				this.logRaiseFailure(err);
			}
		}
	}

	/**
	 * Serves the property inspector's `datasource="getTerminals"` picker (see
	 * `ui/agent-slot.html`). Detects which known terminal apps are currently
	 * running and sends them back as select items - this is a convenience
	 * only; the property inspector's free-text field still works for any app
	 * not in the detected list.
	 *
	 * Must never reject: this is wired up by the SDK as a plain event
	 * listener (see the project's own `route()` wiring in
	 * `@elgato/streamdeck`), not something any caller awaits, so a rejection
	 * here would become an unhandled promise rejection - the exact failure
	 * mode `logRenderFailure`'s doc comment (and `unhandled-rejection.ts`)
	 * describes as having already taken this plugin down twice before.
	 */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, AgentSlotSettings>): Promise<void> {
		const payload = ev.payload;
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
		const event = (payload as { event?: unknown }).event;

		if (event === GET_TERMINALS_EVENT) {
			const detected = await detectRunningTerminalApps();
			const items = detected.map((name) => ({ label: name, value: name }));
			await this.replyToPropertyInspector(GET_TERMINALS_EVENT, items);
			return;
		}

		if (event === GET_SLOTS_EVENT) {
			// Reads only in-memory allocator/registry state, so the slot list is
			// available (and every slot selectable) even while herdr is down -
			// only the agent/directory annotation needs a live connection.
			const items = slotSelectItems(registry, allocator(), SLOT_COUNT);
			await this.replyToPropertyInspector(GET_SLOTS_EVENT, items);
			return;
		}
	}

	/**
	 * Sends a datasource reply back to the property inspector, swallowing (and
	 * logging) any failure. Same non-negotiable reason as the callers' own doc
	 * comment: onSendToPlugin is wired as a plain event listener, so a rejection
	 * escaping here would be an unhandled rejection that can take the plugin down.
	 */
	private async replyToPropertyInspector(event: string, items: { label: string; value: string }[]): Promise<void> {
		try {
			await streamDeck.ui.sendToPropertyInspector({ event, items });
		} catch (err) {
			this.logSendToPropertyInspectorFailure(err);
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
		// Finding 2/3: reconciliation is hoisted out of the per-key loop below
		// and done once per renderAll() pass (see reconcileSlotAssignments' own
		// comment). saveSlots() itself now serializes/coalesces overlapping
		// calls (see plugin-state.ts), but calling it at most once here,
		// rather than once per key, removes most of the burst to begin with.
		const changed = reconcileSlotAssignments(registry, allocator());
		if (changed) {
			saveSlots().catch((err: unknown) => this.logSaveFailure(err));
		}

		for (const instance of this.actions) {
			if (!instance.isKey()) continue;
			const key = instance as KeyAction<AgentSlotSettings>;
			const slotIndex = this.slotIndexByActionId.get(key.id) ?? 0;
			const render = slotRenderFor(registry, allocator(), slotIndex);
			await key.setImage(slotImage(render, this.pulseOn));
			// The agent name and project now live inside the key image itself (see
			// slots/render.ts's `label`), so the Stream Deck title row is cleared
			// rather than duplicating that text below the icon. setTitle("") also
			// wipes any title left over from a previous render/state.
			await key.setTitle("");
		}
	}

	private logRenderFailure(err: unknown): void {
		streamDeck.logger.error("agent-slot: renderAll failed", err);
	}

	private logSaveFailure(err: unknown): void {
		streamDeck.logger.error("agent-slot: saveSlots failed", err);
	}

	/**
	 * Non-negotiable failure-handling rule for the terminal-raise feature: a
	 * failure to raise the configured terminal app must never prevent, undo,
	 * or appear to undo the `agent.focus` that already succeeded before it
	 * was attempted. Logging and moving on (never `showAlert()`, never
	 * rethrowing) is what keeps a successful focus from looking like a failed
	 * key press.
	 */
	private logRaiseFailure(err: unknown): void {
		streamDeck.logger.error("agent-slot: raiseTerminalApp failed", err);
	}

	private logSendToPropertyInspectorFailure(err: unknown): void {
		streamDeck.logger.error("agent-slot: sendToPropertyInspector failed", err);
	}
}
