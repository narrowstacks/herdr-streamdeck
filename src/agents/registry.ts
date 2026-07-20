import { EventEmitter } from "node:events";
import type { HerdrClient } from "../herdr/client.js";
import type { AgentInfo, AgentStatus } from "../herdr/types.js";

export interface AgentRegistryOptions {
	reconcileIntervalMs?: number;
}

interface RawAgent {
	agent?: string;
	agent_status?: string;
	cwd?: string;
	focused?: boolean;
	pane_id?: string;
	workspace_id?: string;
}

const STATUSES: AgentStatus[] = ["idle", "working", "blocked", "unknown"];

function toStatus(raw: string | undefined): AgentStatus {
	return STATUSES.includes(raw as AgentStatus) ? (raw as AgentStatus) : "unknown";
}

function toAgentInfo(raw: RawAgent): AgentInfo {
	return {
		paneId: raw.pane_id ?? "",
		agent: raw.agent ?? "unknown",
		status: toStatus(raw.agent_status),
		cwd: raw.cwd ?? "",
		focused: raw.focused === true,
		workspaceId: raw.workspace_id ?? "",
	};
}

export class AgentRegistry extends EventEmitter {
	private byPaneId = new Map<string, AgentInfo>();
	private timer?: NodeJS.Timeout;
	private stopped = false;

	constructor(
		private readonly client: HerdrClient,
		private readonly options: AgentRegistryOptions = {},
	) {
		super();
	}

	get connected(): boolean {
		return this.client.connected;
	}

	get agents(): AgentInfo[] {
		return [...this.byPaneId.values()];
	}

	getByPaneId(paneId: string): AgentInfo | undefined {
		return this.byPaneId.get(paneId);
	}

	getByCwd(cwd: string): AgentInfo | undefined {
		return this.agents.find((a) => a.cwd === cwd);
	}

	get focused(): AgentInfo | undefined {
		return this.agents.find((a) => a.focused);
	}

	async start(): Promise<void> {
		this.stopped = false;
		this.client.on("disconnected", this.onDisconnected);
		this.client.on("connected", this.onConnected);
		await this.reconcile();
		this.scheduleTick();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.client.off("disconnected", this.onDisconnected);
		this.client.off("connected", this.onConnected);
	}

	private onDisconnected = (): void => {
		this.byPaneId.clear();
		this.emit("changed");
	};

	private onConnected = (): void => {
		void this.reconcile();
	};

	private scheduleTick(): void {
		if (this.stopped) return;
		const interval = this.options.reconcileIntervalMs ?? 5000;
		this.timer = setTimeout(async () => {
			await this.reconcile();
			this.scheduleTick();
		}, interval);
	}

	protected async reconcile(): Promise<void> {
		if (!this.client.connected) return;
		let result: { agents?: RawAgent[] };
		try {
			result = await this.client.request<{ agents?: RawAgent[] }>("agent.list", {});
		} catch {
			return; // disconnect path already emits changed
		}

		const next = new Map<string, AgentInfo>();
		for (const raw of result.agents ?? []) {
			const info = toAgentInfo(raw);
			if (info.paneId) next.set(info.paneId, info);
		}

		if (this.differs(next)) {
			this.byPaneId = next;
			this.emit("changed");
		} else {
			this.byPaneId = next;
		}
	}

	private differs(next: Map<string, AgentInfo>): boolean {
		if (next.size !== this.byPaneId.size) return true;
		for (const [paneId, info] of next) {
			const prev = this.byPaneId.get(paneId);
			if (!prev) return true;
			if (
				prev.status !== info.status ||
				prev.focused !== info.focused ||
				prev.cwd !== info.cwd ||
				prev.agent !== info.agent
			) {
				return true;
			}
		}
		return false;
	}
}
