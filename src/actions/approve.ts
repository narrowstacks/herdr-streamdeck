import { action } from "@elgato/streamdeck";
import { ApprovalActionBase } from "./approval-action.js";

@action({ UUID: "com.aaronfa.herdr-agents.approve" })
export class ApproveAction extends ApprovalActionBase {
	protected readonly intent = "approve" as const;
}
