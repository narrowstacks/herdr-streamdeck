import type { AgentInfo } from "../herdr/types.js";
import { resolveKeymap, type KeymapTable, type KeySequence } from "../keymap/keymap.js";

export interface ApprovalInput {
	connected: boolean;
	focused: AgentInfo | undefined;
	intent: "approve" | "deny";
	table?: KeymapTable;
	override?: Partial<KeySequence>;
}

export type ApprovalDecision =
	| { ok: true; paneId: string; keys: string[] }
	| {
			ok: false;
			reason: "disconnected" | "no-focused-agent" | "not-blocked" | "invalid-pane" | "empty-keys";
	  };

export function decideApproval(input: ApprovalInput): ApprovalDecision {
	if (!input.connected) return { ok: false, reason: "disconnected" };
	if (!input.focused) return { ok: false, reason: "no-focused-agent" };
	if (input.focused.status !== "blocked") return { ok: false, reason: "not-blocked" };
	if (typeof input.focused.paneId !== "string" || input.focused.paneId.length === 0) {
		return { ok: false, reason: "invalid-pane" };
	}

	const sequence = resolveKeymap(input.focused.agent, input.table, input.override);
	const keys = input.intent === "approve" ? sequence.approve : sequence.deny;
	if (!Array.isArray(keys) || keys.length === 0) {
		return { ok: false, reason: "empty-keys" };
	}

	return {
		ok: true,
		paneId: input.focused.paneId,
		keys,
	};
}
