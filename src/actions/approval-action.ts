import streamDeck, {
	SingletonAction,
	type KeyAction,
	type KeyDownEvent,
	type WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { client, keymapTable, registry } from "../plugin-state.js";
import { decideApproval } from "./approval.js";
import { approvalImage, approvalKeyState } from "./approval-render.js";
import { overrideFromSettings } from "./approval-override.js";

// See the matching comment in agent-slot.ts for why this needs an explicit
// JsonValue index signature rather than `unknown`.
export interface ApprovalSettings {
	// Approve/deny key sequences as typed in the property inspector
	// (whitespace/comma-separated), normalised into the override arrays
	// resolveKeymap expects by overrideFromSettings(). Blank = use the keymap.
	approveKeys?: string;
	denyKeys?: string;
	[key: string]: JsonValue | undefined;
}

export abstract class ApprovalActionBase extends SingletonAction<ApprovalSettings> {
	protected abstract readonly intent: "approve" | "deny";

	constructor() {
		super();
		// Same non-negotiable rule as AgentSlotAction's constructor: this is a
		// plain EventEmitter callback nobody awaits, so any rejection from
		// renderAll() must be caught here or it becomes an unhandled rejection
		// that (Node >=20) terminates the plugin. See agent-slot.ts and
		// unhandled-rejection.ts.
		registry.on("changed", () => {
			this.renderAll().catch((err: unknown) => this.logRenderFailure(err));
		});
	}

	override async onWillAppear(ev: WillAppearEvent<ApprovalSettings>): Promise<void> {
		await this.renderAll();
	}

	override async onKeyDown(ev: KeyDownEvent<ApprovalSettings>): Promise<void> {
		const decision = decideApproval({
			connected: registry.connected,
			focused: registry.focused,
			intent: this.intent,
			table: keymapTable(),
			override: overrideFromSettings(ev.payload.settings),
		});

		if (!decision.ok) {
			await ev.action.showAlert();
			return;
		}

		try {
			await client.request("pane.send_keys", {
				pane_id: decision.paneId,
				keys: decision.keys,
			});
			await ev.action.showOk();
		} catch {
			await ev.action.showAlert();
		}
	}

	/**
	 * Repaints every visible key of this action type to match the current
	 * armed/disarmed/disconnected state. The state is computed WITHOUT a
	 * per-key `override` (which only affects the rare empty-keys case): every
	 * key of one intent targets the same focused agent, so they share one image
	 * and one round trip's worth of work, rather than a getSettings() per key.
	 */
	private async renderAll(): Promise<void> {
		const state = approvalKeyState(
			decideApproval({
				connected: registry.connected,
				focused: registry.focused,
				intent: this.intent,
				table: keymapTable(),
			}),
		);
		const image = approvalImage(this.intent, state);
		for (const instance of this.actions) {
			if (!instance.isKey()) continue;
			await (instance as KeyAction<ApprovalSettings>).setImage(image);
		}
	}

	private logRenderFailure(err: unknown): void {
		streamDeck.logger.error(`approval(${this.intent}): renderAll failed`, err);
	}
}
