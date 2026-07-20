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

// Defensive by construction: a malformed entry (null, a non-object, or one
// missing a usable pane_id) returns `undefined` instead of throwing. Finding
// 2's repro was `agents: [null]` blowing up on `.pane_id` outside any
// try/catch, which killed the poll loop forever (see reconcile()/tick()).
// There's no key to track a pane-id-less agent by anyway, so callers just
// skip it - see Finding 6 for making that observable instead of silent.
function toAgentInfo(raw: unknown): AgentInfo | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const r = raw as RawAgent;
	if (typeof r.pane_id !== "string" || r.pane_id.length === 0) return undefined;
	return {
		paneId: r.pane_id,
		agent: typeof r.agent === "string" ? r.agent : "unknown",
		status: toStatus(typeof r.agent_status === "string" ? r.agent_status : undefined),
		cwd: typeof r.cwd === "string" ? r.cwd : "",
		focused: r.focused === true,
		workspaceId: typeof r.workspace_id === "string" ? r.workspace_id : "",
	};
}

export class AgentRegistry extends EventEmitter {
	private byPaneId = new Map<string, AgentInfo>();
	private timer?: NodeJS.Timeout;
	private stopped = false;
	private started = false;
	// Finding 1: whether the most recent reconcile that actually talked to
	// herdr succeeded. A JSON-RPC {error} response leaves the socket open -
	// `client.connected` stays true - so it can't be the signal that data is
	// stale. This is. See the `connected` getter and reconcile()'s catch.
	private lastReconcileOk = true;
	// Finding 6: agents missing pane_id are dropped (there's no key to track
	// them by), but that shouldn't be silent. Callers can watch this counter
	// or listen for "agent:malformed" (emitted with the count dropped on
	// that reconcile) to notice herdr is sending bad data.
	private droppedMalformedCount = 0;

	constructor(
		private readonly client: HerdrClient,
		private readonly options: AgentRegistryOptions = {},
	) {
		super();
	}

	// Finding 1: never report a trustworthy live state when the data behind
	// it might be stale. The socket can stay open while agent.list itself
	// fails (herdr returns {error}), so `client.connected` alone isn't
	// enough - `lastReconcileOk` tracks whether the last attempt to actually
	// fetch data succeeded. Every downstream consumer already renders a
	// distinct (non-live) state when `connected` is false, so folding this
	// in here makes them all correct automatically with no other changes.
	get connected(): boolean {
		return this.client.connected && this.lastReconcileOk;
	}

	get agents(): AgentInfo[] {
		return [...this.byPaneId.values()];
	}

	/** Finding 6: count of agent entries dropped for lacking a usable pane_id, across the registry's lifetime. */
	get droppedMalformedAgents(): number {
		return this.droppedMalformedCount;
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

	// Finding 4: idempotent. A second start() while already started (or
	// still starting - `started` is set before the first `await`) is a
	// no-op, so listeners never get double-registered and only one
	// reconcile/tick chain ever exists. Call stop() first to restart.
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.stopped = false;
		this.client.on("disconnected", this.onDisconnected);
		this.client.on("connected", this.onConnected);
		await this.reconcile();
		this.scheduleTick();
	}

	// Finding 4/5: genuinely stops everything - listeners are detached and
	// the timer chain is cancelled, and `stopped` also makes any reconcile()
	// already in flight (awaiting client.request) discard its result instead
	// of mutating state or emitting after stop() returns. `started = false`
	// lets a later start() begin a fresh chain rather than staying inert.
	stop(): void {
		this.started = false;
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.client.off("disconnected", this.onDisconnected);
		this.client.off("connected", this.onConnected);
	}

	private onDisconnected = (): void => {
		this.byPaneId.clear();
		// A fresh connection deserves a fresh, optimistic trust state; the
		// next reconcile() will flip it back to false again if it also fails.
		this.lastReconcileOk = true;
		this.emit("changed");
	};

	private onConnected = (): void => {
		// Finding 2(c): reconcile() is written to never reject, but this
		// backstop guarantees a future bug there can't become an unhandled
		// rejection on this fire-and-forget call site.
		this.reconcile().catch(() => {});
	};

	private scheduleTick(): void {
		if (this.stopped) return;
		const interval = this.options.reconcileIntervalMs ?? 5000;
		this.timer = setTimeout(() => {
			void this.tick();
		}, interval);
	}

	// Finding 2(b): the tick chain survives any reconcile() failure. reconcile()
	// itself is written to never throw, but this try/finally is a second,
	// independent guarantee - even a future bug inside reconcile() can only
	// skip one tick's worth of work, never permanently stop polling the way
	// the original `await this.reconcile(); this.scheduleTick();` chain did.
	private async tick(): Promise<void> {
		try {
			await this.reconcile();
		} catch {
			/* reconcile() must never throw; this is a defensive backstop. */
		} finally {
			this.scheduleTick();
		}
	}

	protected async reconcile(): Promise<void> {
		if (this.stopped || !this.client.connected) return;

		let result: { agents?: RawAgent[] };
		try {
			result = await this.client.request<{ agents?: RawAgent[] }>("agent.list", {});
		} catch {
			// Finding 1: a rejected agent.list while the socket stays open
			// (herdr returned a JSON-RPC {error}) is NOT the same as a
			// disconnect - onDisconnected already owns clearing state and
			// emitting "changed" for that case. If the drop DID happen
			// mid-request instead, client.connected is already false by now
			// (HerdrClient flips it before rejecting pending requests), so
			// the branch below is a no-op there and onDisconnected handles
			// it. Only the "socket fine, RPC failed" case needs this: without
			// it, `connected` would keep reading true and `agents` would
			// keep serving pre-failure data forever.
			if (this.stopped) return;
			if (this.client.connected && this.lastReconcileOk) {
				this.lastReconcileOk = false;
				this.emit("changed");
			}
			return;
		}

		// Finding 5: an in-flight reconcile whose client.request settled
		// after stop() must not mutate byPaneId or emit.
		if (this.stopped) return;

		const next = new Map<string, AgentInfo>();
		let malformed = 0;
		for (const raw of result.agents ?? []) {
			const info = toAgentInfo(raw);
			if (info) {
				next.set(info.paneId, info);
			} else {
				malformed++;
			}
		}
		if (malformed > 0) {
			this.droppedMalformedCount += malformed;
			this.emit("agent:malformed", malformed);
		}

		// Recovering from a prior RPC failure is itself a state transition
		// consumers need to see, even if the agent data looks the same as
		// what was last (successfully) reconciled.
		const recovered = !this.lastReconcileOk;
		this.lastReconcileOk = true;

		if (recovered || this.differs(next)) {
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
				prev.agent !== info.agent ||
				prev.workspaceId !== info.workspaceId
			) {
				return true;
			}
		}
		return false;
	}
}
