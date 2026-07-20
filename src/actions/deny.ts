import { action } from "@elgato/streamdeck";
import { ApprovalActionBase } from "./approval-action.js";

@action({ UUID: "com.aaronfa.herdr-agents.deny" })
export class DenyAction extends ApprovalActionBase {
	protected readonly intent = "deny" as const;
}
