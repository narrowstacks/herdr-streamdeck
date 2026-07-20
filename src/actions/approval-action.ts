import { SingletonAction, type KeyDownEvent } from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { client, keymapTable, registry } from "../plugin-state.js";
import { decideApproval } from "./approval.js";
import type { KeySequence } from "../keymap/keymap.js";

// See the matching comment in agent-slot.ts for why this needs an explicit
// JsonValue index signature rather than `unknown`.
export interface ApprovalSettings {
	override?: Partial<KeySequence>;
	[key: string]: JsonValue | undefined;
}

export abstract class ApprovalActionBase extends SingletonAction<ApprovalSettings> {
	protected abstract readonly intent: "approve" | "deny";

	override async onKeyDown(ev: KeyDownEvent<ApprovalSettings>): Promise<void> {
		const decision = decideApproval({
			connected: registry.connected,
			focused: registry.focused,
			intent: this.intent,
			table: keymapTable(),
			override: ev.payload.settings.override,
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
}
