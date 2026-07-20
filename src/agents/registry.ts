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

// Finding 4 (round 3): the third shape of the same bug class - `result`
// itself being something other than an object (null, a number, a string, an
// array, ...) - blew up on `result.agents` outside any guard, or worse, in
// some of those shapes (numbers/strings/arrays don't have an `.agents`
// property either, so the read just silently produces `undefined`) sailed
// through as if agent.list had returned zero agents. Neither failure mode is
// acceptable: one crashes the reconcile loop, the other reports `connected
// === true` off data that was never actually validated.
//
// The fix is to stop trusting the RPC's declared return type entirely.
// `client.request` is called with `<unknown>` (see reconcile()) and this is
// the ONE place that decides whether an `unknown` response counts as
// "agent.list actually answered": a plain object with an array `agents`
// property, full stop. Every response shape that isn't that - including an
// object with no `agents` property at all, which the pre-round-3 code
// treated as "zero agents" (success) rather than "malformed" - is rejected
// here, before a single expression downstream ever reads into it. There is
// no second code path that also reads `result.agents`; reconcile() only
// proceeds past this guard once `result` has been narrowed to
// `AgentListResult`, so no future response shape can reach an unguarded
// read no matter what herdr sends.
interface AgentListResult {
	agents: unknown[];
}

function isAgentListResult(value: unknown): value is AgentListResult {
	return (
		typeof value === "object" && value !== null && Array.isArray((value as { agents?: unknown }).agents)
	);
}

const STATUSES: AgentStatus[] = ["idle", "working", "blocked", "unknown"];

function toStatus(raw: string | undefined): AgentStatus {
	return STATUSES.includes(raw as AgentStatus) ? (raw as AgentStatus) : "unknown";
}

// herdr's global pane-lifecycle subscriptions - no `pane_id`, confirmed
// against a live herdr server not to require one (unlike
// pane.agent_status_changed below, which does). Subscribed once, globally,
// in start() and again on every reconnect, since herdr has no unsubscribe
// and subscriptions do not survive a new connection.
const LIFECYCLE_SUBSCRIPTIONS = [
	{ type: "pane.created" },
	{ type: "pane.closed" },
	{ type: "pane.agent_detected" },
];

// Verified against a live herdr server (0.6.9, protocol 13; see
// .superpowers/sdd/real-herdr-events.md for the captured wire payloads):
// pushed events are `{ event: "<name>", data: {...} }`, NOT the
// `{type, pane_id, agent_status}` top-level shape this file was originally
// written against. The discriminator key is `event`; every field a handler
// keys on lives under `data`.
//
// The delivered `event` name is also inconsistently spelled depending on
// which subscription produced it, and this is NOT a bug to normalize away:
// `pane.agent_status_changed` is delivered dotted (matching its subscription
// name), while `pane.created` / `pane.closed` / `pane.agent_detected` are
// delivered underscored (`pane_created` / `pane_closed` /
// `pane_agent_detected`). Both spellings are accepted for every event type
// below so that a future herdr release settling on either convention (or a
// dotted `pane_agent_status_changed`, never observed but not ruled out)
// doesn't silently drop half the events again.
const LIFECYCLE_EVENT_NAMES = new Set([
	"pane.created",
	"pane_created",
	"pane.closed",
	"pane_closed",
	"pane.agent_detected",
	"pane_agent_detected",
]);

const STATUS_CHANGED_EVENT_NAMES = new Set(["pane.agent_status_changed", "pane_agent_status_changed"]);

// The second untrusted input path (the first being agent.list's response,
// guarded by isAgentListResult above). A pushed event is whatever herdr
// wrote to the socket, parsed as JSON with zero shape guarantee - it can be
// null, a primitive, an array, an object missing `event`/`data`, or a
// pane.agent_status_changed whose `data` is missing/non-object or has a
// missing/non-string pane_id. This is the SOLE place that reads into a
// pushed event's fields, mirroring isAgentListResult(): every field access
// (`event`, `data`, `pane_id`, `agent_status`) happens here, once, behind
// typeof/null checks, and nothing downstream (onEvent) reads the raw
// payload directly.
type ParsedHerdrEvent =
	| { kind: "lifecycle" }
	| { kind: "status"; paneId: string; status: AgentStatus };

function parseHerdrEvent(value: unknown): ParsedHerdrEvent | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const eventName = (value as { event?: unknown }).event;
	if (typeof eventName !== "string") return undefined;
	const data = (value as { data?: unknown }).data;
	if (typeof data !== "object" || data === null) return undefined;

	if (LIFECYCLE_EVENT_NAMES.has(eventName)) return { kind: "lifecycle" };

	if (STATUS_CHANGED_EVENT_NAMES.has(eventName)) {
		const paneId = (data as { pane_id?: unknown }).pane_id;
		if (typeof paneId !== "string" || paneId.length === 0) return undefined;
		const agentStatus = (data as { agent_status?: unknown }).agent_status;
		return {
			kind: "status",
			paneId,
			status: toStatus(typeof agentStatus === "string" ? agentStatus : undefined),
		};
	}

	return undefined;
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
	//
	// Starts false, and stays false across a disconnect/reconnect, on
	// purpose: this flag means "real data has been confirmed fresh", and
	// that's only true once reconcile()'s own success path says so. Resetting
	// it optimistically anywhere else (e.g. the moment the socket reconnects)
	// would let `connected` read true for the span of one agent.list round
	// trip with nothing behind it - the exact stale-while-connected failure
	// this flag exists to prevent.
	private lastReconcileOk = false;
	// Finding 6: agents missing pane_id are dropped (there's no key to track
	// them by), but that shouldn't be silent. Callers can watch this counter
	// or listen for "agent:malformed" (emitted with the count dropped on
	// that reconcile) to notice herdr is sending bad data.
	private droppedMalformedCount = 0;
	// Tracks pane ids we've already sent a `pane.agent_status_changed`
	// subscription for. herdr exposes no unsubscribe, so subscriptions for
	// panes that later close are simply left to lapse - this set exists only
	// to prevent re-sending a duplicate subscribe for a pane already covered.
	// Cleared on disconnect (see onDisconnected): subscriptions do not
	// survive a new connection, so the bookkeeping for the old one is void.
	private subscribedPanes = new Set<string>();
	// Finding 1 (round 4) / Finding 2 (round 4): reconcile() has no fewer than
	// four unsynchronized call sites - tick()'s timer, onConnected, and now a
	// fire-and-forget call for every pushed lifecycle event - and nothing
	// upstream guarantees their agent.list round trips resolve in the order
	// they were sent. Without a guard, a reconcile started earlier (and so
	// carrying an older, possibly-already-superseded snapshot) can resolve
	// AFTER a reconcile started later and unconditionally overwrite fresher
	// state - reverting a pane that's actually `blocked` back to `working`
	// and telling every consumer about it via "changed". That is exactly the
	// failure this whole registry exists to prevent.
	//
	// The fix is a monotonic sequence number, stamped on each reconcile()
	// attempt the instant it starts (i.e. in trigger order, not response
	// order). `appliedSeq` is the sequence number of the last attempt whose
	// outcome - success OR failure - actually got applied to state.
	// Immediately after every await inside reconcile() (the agent.list round
	// trip, and again after subscribeNewPanes()'s own round trip), an attempt
	// checks whether a strictly newer attempt has already applied since it
	// started; if so, it discards itself completely - no byPaneId mutation,
	// no subscribeNewPanes() call (or, if already past that check, no emit) -
	// rather than clobber data that is, by definition, more current than its
	// own. Whichever attempt was started MOST RECENTLY always wins, never
	// whichever happens to answer first.
	private reconcileSeq = 0;
	private appliedSeq = 0;

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
		this.client.on("event", this.onEvent);

		// Global, pane_id-less subscriptions (verified against a live herdr
		// server not to require one - unlike pane.agent_status_changed).
		// Best-effort: a subscribe failure here must not stop start() or
		// reconcile()/the poll loop, which remains the self-healing backstop
		// regardless of whether push ever works.
		try {
			await this.client.subscribe(LIFECYCLE_SUBSCRIPTIONS);
		} catch {
			/* push is an accelerant, not a dependency; poll still covers us. */
		}

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
		this.client.off("event", this.onEvent);
	}

	private onDisconnected = (): void => {
		this.byPaneId.clear();
		// Deliberately do NOT reset lastReconcileOk here. It's cleared, not
		// restored, exactly like byPaneId above: only the next successful
		// reconcile() - with real data confirmed fresh from herdr - is allowed
		// to set it back to true. Optimistically restoring it on reconnect
		// would make `connected` read true before any post-reconnect data has
		// arrived, for the whole span of the next agent.list round trip.
		this.lastReconcileOk = false;
		// Subscriptions do not survive a new connection - herdr has no
		// unsubscribe, so the old socket's subscriptions simply die with it.
		// Clearing this means the next reconcile()'s subscribeNewPanes() will
		// re-subscribe every still-live pane on the new connection instead of
		// believing (wrongly) that they're already covered.
		this.subscribedPanes.clear();
		this.emit("changed");
	};

	private onConnected = (): void => {
		// Finding 2(c): reconcile() is written to never reject, but the
		// try/catch below is a backstop guarantee that a future bug there
		// can't become an unhandled rejection on this fire-and-forget call
		// site. The subscribe attempt is wrapped separately for the same
		// reason as in start(): a failed re-subscribe must not block
		// reconcile() from running, since poll is the backstop either way.
		void (async () => {
			try {
				await this.client.subscribe(LIFECYCLE_SUBSCRIPTIONS);
			} catch {
				/* push is an accelerant, not a dependency; poll still covers us. */
			}
			try {
				await this.reconcile();
			} catch {
				/* reconcile() must never throw; defensive backstop, see tick(). */
			}
		})();
	};

	// The second untrusted input path's single entry point (see
	// parseHerdrEvent above for why). Every pushed event, whatever its shape,
	// funnels through here: parseHerdrEvent() either returns a validated
	// event or `undefined`, and `undefined` is a silent no-op - never a
	// throw, and never a state change built on data that wasn't actually
	// validated. A lifecycle event (pane created/closed/agent detected)
	// nudges a reconcile so the poll path picks up the new pane and, in turn,
	// subscribes to it; a status event only ever updates a pane already
	// known from a validated agent.list response, never creates one - an
	// event for an unknown pane is exactly as unauthoritative as an event
	// with no `pane_id` at all, so both are dropped the same way.
	private onEvent = (raw: unknown): void => {
		const event = parseHerdrEvent(raw);
		if (!event) return;

		if (event.kind === "lifecycle") {
			// Never let a bug in reconcile() surface as an unhandled rejection
			// on this fire-and-forget call site (same contract as onConnected).
			this.reconcile().catch(() => {});
			return;
		}

		const existing = this.byPaneId.get(event.paneId);
		if (!existing) return;
		if (existing.status === event.status) return;
		this.byPaneId.set(event.paneId, { ...existing, status: event.status });
		this.emit("changed");
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

		// Finding 1/2 (round 4): stamp this attempt with the next sequence
		// number NOW, synchronously, before any await - so `seq` reflects the
		// order reconciles were STARTED (which is what "most recent" has to
		// mean; response order is untrustworthy, see the class-level comment
		// on reconcileSeq/appliedSeq). Every subsequent checkpoint in this
		// method compares against `this.appliedSeq` to decide whether a
		// strictly newer attempt has already applied since this one began -
		// and if so, discards this attempt's outcome outright rather than
		// letting older data win a race it has no business winning.
		const seq = ++this.reconcileSeq;

		// Finding 4 (round 3): the response type is `unknown`, not a lying
		// `{ agents?: RawAgent[] }` shape - herdr is an external process and
		// nothing about the JSON-RPC transport guarantees it sends what the
		// method name promises. Every read into `result` from here on is
		// gated by isAgentListResult() below; nothing upstream of that call
		// is trusted.
		let result: unknown;
		try {
			result = await this.client.request<unknown>("agent.list", {});
		} catch {
			// Finding 5: an in-flight reconcile whose client.request settled
			// after stop() must not touch state.
			if (this.stopped) return;
			// Finding 1/2 (round 4): a newer attempt already applied its own
			// outcome (success or failure) while this one was in flight - this
			// failure is stale news and must not flip a since-recovered
			// `lastReconcileOk` back to false, nor re-emit over it.
			if (this.isSuperseded(seq)) return;
			// Finding 1: a rejected agent.list while the socket stays open
			// (herdr returned a JSON-RPC {error}) is NOT the same as a
			// disconnect - onDisconnected already owns clearing state and
			// emitting "changed" for that case. If the drop DID happen
			// mid-request instead, client.connected is already false by now
			// (HerdrClient flips it before rejecting pending requests), so
			// failReconcile() below is a no-op there and onDisconnected
			// handles it. Only the "socket fine, RPC failed" case needs
			// this: without it, `connected` would keep reading true and
			// `agents` would keep serving pre-failure data forever.
			this.appliedSeq = seq;
			this.failReconcile();
			return;
		}

		// Finding 5: an in-flight reconcile whose client.request settled
		// after stop() must not mutate byPaneId or emit.
		if (this.stopped) return;

		// Finding 1/2 (round 4): the single concurrency checkpoint for a
		// successful response. A strictly newer reconcile already applied its
		// outcome while this one's agent.list round trip was in flight -
		// this is the reviewer's exact repro (a stale `working` snapshot
		// released after a fresher `blocked` one already landed). Discard
		// whole: no byPaneId mutation, no malformed-count bump, no
		// subscribeNewPanes() call, no emit. The reconcile that actually is
		// newest already (or will) speak for the registry's current state.
		if (this.isSuperseded(seq)) return;

		// Finding 4 (round 3): the single boundary. Every response shape that
		// isn't a plain object with an array `agents` property - null,
		// undefined, a number, a string, an array, an object with a
		// non-array `agents`, or an object with no `agents` at all - is
		// indistinguishable from a failed request from here on: same
		// failReconcile() path, same "no throw, no stale-live read" contract.
		// Nothing below this line executes unless `result` has been narrowed
		// to `AgentListResult`, so no expression that reads into the
		// response can sit outside this check.
		if (!isAgentListResult(result)) {
			this.appliedSeq = seq;
			this.failReconcile();
			return;
		}

		const next = new Map<string, AgentInfo>();
		let malformed = 0;
		for (const raw of result.agents) {
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
		// what was last (successfully) reconciled. differs() must run before
		// byPaneId is reassigned below, since it compares `next` against the
		// still-current (pre-reconcile) map.
		const recovered = !this.lastReconcileOk;
		const shouldEmit = recovered || this.differs(next);
		this.lastReconcileOk = true;
		this.byPaneId = next;
		this.appliedSeq = seq;

		// Subscribe to any pane discovered by this reconcile that we haven't
		// already subscribed to. This is what makes push actually apply to
		// newly-appeared panes rather than just ones seen since start(): the
		// per-pane pane.agent_status_changed subscription requires a pane_id
		// (verified against a live herdr server), so it can only be sent once
		// a pane is known, i.e. from here - never up front in start().
		await this.subscribeNewPanes();

		// Finding 5, extended: subscribeNewPanes() awaits a network round
		// trip. If stop() ran during that await, this reconcile must not
		// emit after it - byPaneId is already a private, internally
		// consistent snapshot at this point (assigned synchronously above),
		// so leaving it in place is fine; only the outward-facing emit is
		// guarded.
		if (this.stopped) return;

		// Finding 1/2 (round 4): even newer still - a reconcile started after
		// this one both ran AND applied while subscribeNewPanes()'s own
		// network round trip was in flight. This one's `shouldEmit` was
		// computed against a byPaneId snapshot that's no longer current (the
		// newer attempt already overwrote it and already emitted its own
		// "changed" for it), so emitting here too would be a stale,
		// redundant - and potentially misleading - second announcement.
		if (this.appliedSeq !== seq) return;

		if (shouldEmit) this.emit("changed");
	}

	// Finding 1/2 (round 4): true when a strictly newer reconcile attempt has
	// already applied its outcome. `appliedSeq` only ever moves forward
	// (never reset), so this is a pure "am I stale" check with no ordering
	// ambiguity: whichever attempt was started most recently is the one
	// whose outcome should stand, regardless of which one's network round
	// trip happens to resolve first.
	private isSuperseded(seq: number): boolean {
		return seq <= this.appliedSeq;
	}

	// herdr has no unsubscribe (see the class-level `subscribedPanes` comment
	// for the full rationale), so this only ever adds subscriptions for
	// panes not already tracked. Subscribing is best-effort: if the request
	// fails, the newly-added ids are rolled back out of `subscribedPanes` so
	// the next reconcile retries them, rather than the pane silently going
	// un-pushed forever while still believed subscribed.
	private async subscribeNewPanes(): Promise<void> {
		const fresh = [...this.byPaneId.keys()].filter((paneId) => !this.subscribedPanes.has(paneId));
		if (fresh.length === 0) return;
		for (const paneId of fresh) this.subscribedPanes.add(paneId);
		try {
			await this.client.subscribe(
				fresh.map((paneId) => ({ type: "pane.agent_status_changed", pane_id: paneId })),
			);
		} catch {
			for (const paneId of fresh) this.subscribedPanes.delete(paneId);
		}
	}

	// Finding 4 (round 3): the one place that flips lastReconcileOk to false
	// and emits "changed" on that transition, shared by every failure path
	// in reconcile() (request rejection and a structurally invalid
	// response). Collapsing what used to be two copies of this same
	// "was this already known-bad" dance into one method is itself part of
	// the structural fix - a fourth failure shape now has nowhere to grow a
	// third copy.
	private failReconcile(): void {
		if (this.stopped) return;
		if (this.client.connected && this.lastReconcileOk) {
			this.lastReconcileOk = false;
			this.emit("changed");
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
