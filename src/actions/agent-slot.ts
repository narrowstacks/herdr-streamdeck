import {
	action,
	SingletonAction,
	type KeyAction,
	type WillAppearEvent,
	type WillDisappearEvent,
	type KeyDownEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { registry, allocator, saveSlots, client } from "../plugin-state.js";
import { projectLabel, slotImage, slotTitle, type SlotRender } from "../slots/render.js";

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

	constructor() {
		super();
		registry.on("changed", () => void this.renderAll());
	}

	override async onWillAppear(ev: WillAppearEvent<AgentSlotSettings>): Promise<void> {
		const slotIndex = ev.payload.settings.slotIndex ?? 0;
		allocator().registerSlot(slotIndex);
		this.ensurePulse();
		await this.renderAll();
	}

	override async onWillDisappear(ev: WillDisappearEvent<AgentSlotSettings>): Promise<void> {
		const slotIndex = ev.payload.settings.slotIndex ?? 0;
		allocator().unregisterSlot(slotIndex);
		if (this.actions.length === 0) this.stopPulse();
	}

	override async onKeyDown(ev: KeyDownEvent<AgentSlotSettings>): Promise<void> {
		const render = this.renderFor(ev.payload.settings.slotIndex ?? 0);
		if (render.kind !== "agent") {
			await ev.action.showAlert();
			return;
		}
		const cwd = allocator().cwdForSlot(ev.payload.settings.slotIndex ?? 0);
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
			this.pulseOn = !this.pulseOn;
			void this.renderAll();
		}, PULSE_MS);
	}

	private stopPulse(): void {
		if (this.pulseTimer) clearInterval(this.pulseTimer);
		this.pulseTimer = undefined;
	}

	private renderFor(slotIndex: number): SlotRender {
		if (!registry.connected) return { kind: "disconnected" };

		// Claim on demand: any agent whose cwd has no slot yet takes the lowest free one.
		let claimed = false;
		for (const agent of registry.agents) {
			if (allocator().slotForCwd(agent.cwd) === undefined) {
				if (allocator().claim(agent.cwd) !== undefined) claimed = true;
			}
		}
		if (claimed) void saveSlots();

		const cwd = allocator().cwdForSlot(slotIndex);
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

	private async renderAll(): Promise<void> {
		for (const instance of this.actions) {
			if (!instance.isKey()) continue;
			const key = instance as KeyAction<AgentSlotSettings>;
			const settings = await key.getSettings();
			const render = this.renderFor(settings.slotIndex ?? 0);
			await key.setImage(slotImage(render, this.pulseOn));
			await key.setTitle(slotTitle(render));
		}
	}
}
