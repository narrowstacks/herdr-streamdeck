import { EventEmitter } from "node:events";
import net from "node:net";
import type { HerdrResponse, HerdrSubscription } from "./types.js";

export interface HerdrClientOptions {
	socketPath: string;
	reconnectBaseMs?: number;
	reconnectMaxMs?: number;
	/** Per-request (and per-subscribe-ack) timeout. Guards against herdr accepting a
	 * connection and then never responding and never closing it. */
	requestTimeoutMs?: number;
}

// Runtime guard for the JSON-boundary: narrows an arbitrary parsed JSON
// value down to "plausibly a HerdrResponse frame" (a non-null, non-array
// object) without casting. `typeof null === "object"` in JS, so the null
// check is required in addition to the typeof check; arrays are also
// `typeof "object"` and are excluded too, since a bare JSON array is not a
// valid protocol frame either.
function isHerdrFrame(value: unknown): value is HerdrResponse {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function subscriptionKey(sub: HerdrSubscription): string {
	return `${sub.type}:${sub.pane_id ?? ""}`;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const item of a) if (!b.has(item)) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Architecture (see docs/superpowers/specs/2026-07-19-streamdeck-agent-alerts-design.md,
// "Connection model" and "Subscription constraint" - both verified against a
// live herdr 0.6.9 server, protocol 13).
//
// herdr's API socket serves EXACTLY ONE request per connection, then closes
// it. `events.subscribe` is the sole exception: that connection stays open
// indefinitely as a one-way event stream - but sending ANY request on an
// already-subscribed connection (including a second `events.subscribe`)
// causes herdr to close it. Verified directly against the live server: a
// second `events.subscribe` on an already-subscribed socket gets no
// response at all, just an immediate close.
//
// This forces two structurally separate paths, which is why this class has
// no shared "the socket" and no request/response id-correlation map:
//
//  - request(): one brand-new short-lived connection per call. Connect,
//    write one line, read one line, tear down. No multiplexing is possible
//    (or needed - herdr only ever has one request in flight per connection).
//  - The event path (connect()/subscribe()/replaceSubscriptions()): one
//    long-lived connection that sends `events.subscribe` and then only
//    listens. Adding a subscription later (e.g. a newly-discovered pane)
//    cannot be layered onto a live subscribed connection - the verified
//    behavior above means it must close the old connection and open a
//    fresh one, subscribing to the FULL desired set every time.
//
// Two accumulation policies, one wire set (Critical finding fix)
// -----------------------------------------------------------------
// herdr also rejects an `events.subscribe` naming a `pane.agent_status_changed`
// pane_id that doesn't exist (or no longer exists), and closes the
// connection when it does - verified live: `{"error":{"code":"internal_error",
// "message":"failed to decode pane get error"}}` followed by an immediate
// close. Combined with "resend the FULL desired set on every reconnect",
// a desired set that only ever GROWS (the original design: every pane ever
// seen, accumulated forever) means one closed pane permanently wedges the
// event stream: every reconnect resends it, herdr rejects it, the socket
// dies, forever - even though every other subscription in the set is fine.
//
// The desired set is therefore split into two independently-managed pools,
// merged (see combinedDesired()) only at the moment a connection is
// (re)established:
//
//  - "sticky" pool (subscribe()): accumulate-only, exactly the original
//    behavior. Used for the four pane-id-less lifecycle subscriptions
//    (pane.created/closed/agent_detected/focused) - a fixed, small set that
//    never needs pruning and herdr never rejects (they don't name a pane).
//  - "managed" pool (replaceSubscriptions()): wholesale-REPLACED on every
//    call with exactly what's passed in, not merged into history. This is
//    what per-pane pane.agent_status_changed subscriptions use: the caller
//    (AgentRegistry) already knows the current LIVE pane set from its most
//    recent agent.list, and passing that set every time means a closed
//    pane's subscription is simply never re-sent again after the next
//    resync - no accumulated history to prune, because none is kept.
//
// Belt-and-suspenders: even the live pane set can race herdr (a pane can
// close between AgentRegistry's agent.list snapshot and the subscribe frame
// actually landing). So a rejection is also handled reactively: dispatch()
// recognizes a subscribe-error frame (see below), identifies exactly which
// subscription it named via the snapshot sent alongside it, and removes
// that one subscription from whichever pool holds it (dropSubscription())
// before the automatic reconnect resends the (now-shrunk) set. A stale id
// can therefore cost at most a handful of backoff-delayed reconnects to
// self-heal, never a permanent wedge, even if nothing external ever calls
// replaceSubscriptions() again.
//
// Subscribe-error id derivation (Finding 4) - VERIFIED against the live
// server, not invented:
//
//   request: {"id":"sub1","method":"events.subscribe","params":{"subscriptions":[
//     {"type":"pane.agent_status_changed","pane_id":"dead-pane"}]}}
//   response: {"id":"sub1:sub:0:probe","error":{"code":"internal_error",
//     "message":"failed to decode pane get error"}}
//
// A SUCCESSFUL subscribe echoes the request id verbatim (unchanged from the
// original design). A REJECTED one instead answers with a DERIVED id:
// `${requestId}:sub:${index}:probe` where `index` is the zero-based
// position of the offending subscription within the `subscriptions` array
// that was sent - confirmed by sending a 3-entry batch with the bad entry
// at index 1 and observing `sub2:sub:1:probe` come back. herdr also stops
// at the FIRST invalid entry and closes immediately: a batch with two dead
// panes only ever reports the first one, never both in a single frame -
// which is exactly why the reactive drop-and-reconnect loop above can only
// ever prune one bad id per cycle, and why a proactively-accurate desired
// set (the "managed" pool above) matters far more than reacting after the
// fact. The literal trailing `:probe` looks like an internal herdr debug
// tag rather than anything derived from our request content - matching is
// therefore done on the `${requestId}:sub:` PREFIX plus a parsed integer,
// not on the literal suffix, so a future herdr build using a different tag
// there doesn't silently stop being recognized.
// ---------------------------------------------------------------------------
export class HerdrClient extends EventEmitter {
	// --- event-path state ---
	private socket?: net.Socket;
	private buffer = "";
	private isConnected = false;
	private closed = true;
	private attempt = 0;
	private reconnectTimer?: NodeJS.Timeout;
	private nextId = 0;

	// Accumulate-only pool - see the class comment's "Two accumulation
	// policies" section. Populated by subscribe(); never pruned except by a
	// live subscribe-rejection (dropSubscription()), which in practice never
	// applies to this pool since its members never name a pane.
	private stickySubscriptions: HerdrSubscription[] = [];
	private stickyKeys = new Set<string>();

	// Replace-wholesale pool - see the class comment. Populated (and fully
	// superseded on every call, not merged) by replaceSubscriptions(). This
	// is what makes "drive subscriptions from the live pane set" possible:
	// a pane missing from the caller's most recent call is simply absent
	// from this pool on the very next resync, with no accumulated history
	// to actively prune.
	private managedSubscriptions: HerdrSubscription[] = [];
	private managedKeys = new Set<string>();

	// The single events.subscribe request that can be outstanding on the
	// event connection at a time (never more than one - subscribe() and
	// replaceSubscriptions() calls are serialized through `opChain` below).
	// Unlike the request path, there is exactly one request "shape" this
	// connection ever sends, so a single waiter slot (not a Map keyed by
	// id) is all correlation needs.
	private subscribeAckWaiter?: { resolve: () => void; reject: (err: Error) => void };
	private pendingSubscribeId?: string;
	// The exact array sent alongside pendingSubscribeId, kept so a rejection
	// frame's derived id (see class comment) can be resolved back to the
	// concrete HerdrSubscription that failed - dispatch() has only an index
	// to go on, and this is the only place that array still exists once the
	// request has been written to the wire.
	private pendingSubscribeSnapshot?: HerdrSubscription[];

	// The socket for a connect attempt currently mid-handshake, tracked
	// separately from `socket` (which is only assigned once "connect"
	// fires), so close() can kill it before it ever becomes live. `resolve`
	// is that attempt's own promise-executor resolve, kept so close() can
	// settle it directly (see close()) instead of leaving the queued
	// operation that started it hanging forever.
	private connectingSocket?: net.Socket;
	private connectingResolve?: () => void;

	// Serializes every operation that touches the event connection (manual
	// connect(), subscribe(), replaceSubscriptions(), and the automatic
	// post-drop reconnect) so none of them can interleave and race each
	// other's view of `socket` / the subscription pools / `isConnected`.
	// Each queued task's own success/failure is still observable to its
	// caller via the promise enqueue() returns; only the *chain* itself is
	// swallowed (via the no-throw `.then(ok, ok)` below) so one task's
	// rejection can never leak out as an unhandled rejection on a later,
	// unrelated caller's queued task.
	private opChain: Promise<void> = Promise.resolve();

	constructor(private readonly options: HerdrClientOptions) {
		super();
	}

	/** True only once the long-lived event connection has been established
	 * AND, if there was anything to subscribe to, herdr has actually
	 * acknowledged the subscribe (Finding 3) - never merely "the TCP socket
	 * is open". This is deliberately NOT about whether requests can succeed
	 * - the request path (request()) is fully independent, one connection
	 * per call, and works regardless of this flag. This flag exists so a
	 * consumer (AgentRegistry) can know whether push delivery is currently
	 * live, since that's what its own freshness guarantee depends on. */
	get connected(): boolean {
		return this.isConnected;
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const result = this.opChain.then(task);
		this.opChain = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** Ensures the event connection is open. Idempotent: a no-op if already
	 * connected. Does not by itself subscribe to anything - if the desired
	 * set is empty this just opens a bare connection. Mainly useful for
	 * establishing connectivity before the caller knows what to subscribe
	 * to; subscribe()/replaceSubscriptions() alone are sufficient for the
	 * common case. */
	connect(): Promise<void> {
		this.closed = false;
		return this.enqueue(() => this.ensureConnected(false));
	}

	/** Adds subscriptions to the accumulate-only "sticky" pool and ensures
	 * the event connection reflects the full merged set. Use for
	 * subscriptions that never need pruning (herdr's pane-id-less lifecycle
	 * events). If nothing new is being added and the connection is already
	 * up, this is a no-op. If the connection is already up and subscribed,
	 * and something new IS being added, this closes and reopens the
	 * connection (per the verified constraint that a second
	 * events.subscribe on a live subscribed connection just gets closed)
	 * and resubscribes with the full merged set - never an incremental
	 * subscribe on a live connection. */
	subscribe(subscriptions: HerdrSubscription[]): Promise<void> {
		if (subscriptions.length === 0) return Promise.resolve();
		this.closed = false;
		return this.enqueue(() => this.doSubscribe(subscriptions));
	}

	/** Replaces the "managed" pool wholesale with exactly `subscriptions` -
	 * unlike subscribe(), a subscription present in a PREVIOUS call but
	 * absent from this one is dropped, not kept. Use for subscriptions
	 * whose validity is tied to something that can disappear (per-pane
	 * pane.agent_status_changed): the caller is expected to pass the
	 * CURRENT LIVE set every time (e.g. AgentRegistry's most recent
	 * agent.list), not an accumulated history - see the class comment's
	 * "Two accumulation policies" section for why the original
	 * accumulate-forever design could permanently wedge the connection.
	 * An empty array is a meaningful call (drop every managed
	 * subscription), not a no-op, unlike subscribe(). Reopens the
	 * connection only if the resulting set actually differs from what's
	 * already active - calling this repeatedly with an unchanged set (the
	 * common case: a poll tick that discovered nothing new) is cheap. */
	replaceSubscriptions(subscriptions: HerdrSubscription[]): Promise<void> {
		this.closed = false;
		return this.enqueue(() => this.doReplace(subscriptions));
	}

	close(): void {
		this.closed = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		// Kill an in-flight connect attempt (initial, manual, or a fired
		// reconnect timer) synchronously. Settling its promise directly
		// (rather than just destroying the socket and leaving whatever
		// awaits openSocket() to hang) is what keeps a queued connect()/
		// subscribe() from stalling forever when close() interrupts it
		// mid-handshake.
		if (this.connectingSocket) {
			const socket = this.connectingSocket;
			const resolveConnecting = this.connectingResolve;
			this.connectingSocket = undefined;
			this.connectingResolve = undefined;
			socket.removeAllListeners();
			socket.destroy();
			resolveConnecting?.();
		}
		this.teardownSocket();
		if (this.subscribeAckWaiter) {
			const waiter = this.subscribeAckWaiter;
			this.subscribeAckWaiter = undefined;
			this.pendingSubscribeId = undefined;
			this.pendingSubscribeSnapshot = undefined;
			waiter.reject(new Error("herdr client closed"));
		}
	}

	private mergeSticky(subscriptions: HerdrSubscription[]): boolean {
		let added = false;
		for (const sub of subscriptions) {
			const key = subscriptionKey(sub);
			if (!this.stickyKeys.has(key)) {
				this.stickyKeys.add(key);
				this.stickySubscriptions.push(sub);
				added = true;
			}
		}
		return added;
	}

	private async doSubscribe(subscriptions: HerdrSubscription[]): Promise<void> {
		const added = this.mergeSticky(subscriptions);
		await this.ensureConnected(added);
	}

	/** Replaces `managedSubscriptions`/`managedKeys` wholesale (deduping the
	 * input against itself) and reports whether the resulting SET actually
	 * differs from what was already active - the signal doReplace() uses to
	 * decide whether a reopen is warranted. */
	private setManaged(subscriptions: HerdrSubscription[]): boolean {
		const deduped: HerdrSubscription[] = [];
		const nextKeys = new Set<string>();
		for (const sub of subscriptions) {
			const key = subscriptionKey(sub);
			if (nextKeys.has(key)) continue;
			nextKeys.add(key);
			deduped.push(sub);
		}
		if (setsEqual(nextKeys, this.managedKeys)) return false;
		this.managedSubscriptions = deduped;
		this.managedKeys = nextKeys;
		return true;
	}

	private async doReplace(subscriptions: HerdrSubscription[]): Promise<void> {
		const changed = this.setManaged(subscriptions);
		await this.ensureConnected(changed);
	}

	/** Removes a single subscription (by its `type:pane_id` key) from
	 * whichever pool currently holds it. Used only by the subscribe-error
	 * path (see rejectPendingSubscribe()): herdr just told us this exact
	 * subscription is invalid, so re-sending it on the next reconnect would
	 * only reproduce the same rejection forever. */
	private dropSubscription(key: string): void {
		if (this.stickyKeys.delete(key)) {
			this.stickySubscriptions = this.stickySubscriptions.filter((s) => subscriptionKey(s) !== key);
		}
		if (this.managedKeys.delete(key)) {
			this.managedSubscriptions = this.managedSubscriptions.filter((s) => subscriptionKey(s) !== key);
		}
	}

	/** The actual set sent to herdr on (re)connect: sticky ++ managed,
	 * deduped (a managed entry whose key already exists in the sticky pool
	 * is dropped in favor of the sticky one - not expected to occur in
	 * practice since the two pools are used for disjoint subscription
	 * types, but keeps the wire frame from ever carrying a genuine
	 * duplicate). */
	private combinedDesired(): HerdrSubscription[] {
		if (this.managedSubscriptions.length === 0) return this.stickySubscriptions;
		const combined = [...this.stickySubscriptions];
		for (const sub of this.managedSubscriptions) {
			if (!this.stickyKeys.has(subscriptionKey(sub))) combined.push(sub);
		}
		return combined;
	}

	// `wasConnected` is captured up front because it decides two things below:
	// whether swapping the transport is a silent internal detail or a real
	// lifecycle transition, and (in the catch) whether a failure here is a
	// genuine new loss of connectivity or just business-as-usual for a first
	// connect attempt (whose own failure path already handles itself, in
	// openSocket()'s onError).
	private async ensureConnected(forceReopen: boolean): Promise<void> {
		const wasConnected = this.isConnected;
		if (wasConnected && !forceReopen) return;

		if (wasConnected && forceReopen) {
			// Adding a subscription to an already-live connection means
			// swapping its transport out from under it (verified: a second
			// events.subscribe on a live connection just gets it closed, so
			// incremental subscribe isn't an option - see the class comment).
			// This is purely an internal implementation detail: to a consumer,
			// herdr push was never unavailable, so `isConnected` stays true
			// and neither "connected" nor "disconnected" fires for it. Only
			// the catch block below, if the reopen itself fails, turns this
			// into a real reported transition.
			this.destroySocketHandle();
		}

		try {
			await this.openSocket();
			// `this.isConnected` is also checked here (not just `!wasConnected`)
			// because openSocket() can legitimately RESOLVE without ever having
			// connected: close() racing a mid-handshake socket makes onConnect
			// resolve without adopting it (see openSocket()'s own `this.closed`
			// guard) - a close()-interrupted attempt must never be reported as
			// a "connected" transition.
			if (!wasConnected && this.isConnected) this.emit("connected");
		} catch (err) {
			// markDisconnected() is idempotent (a no-op unless `isConnected`
			// is currently true), so this is safe regardless of WHICH path
			// failed: a plain connection failure (onError; nothing was ever
			// adopted, isConnected was never touched this attempt) makes this
			// a no-op, matching the original "only report a transition if we
			// were genuinely live before" behavior. A failure at the
			// subscribe step of a *reopen* of a previously-live connection
			// (onConnect's sendSubscribe rejection handler, below) already
			// called handleDrop() - which already flipped isConnected and
			// emitted - before this catch ever runs, so this is *also* a
			// no-op there; the transition was already reported exactly once.
			this.markDisconnected();
			throw err;
		}
	}

	/** Destroys the current socket without touching `isConnected` - used only
	 * by the silent-reopen path above, where the caller is about to establish
	 * a replacement and connectivity is not considered to have lapsed. */
	private destroySocketHandle(): void {
		const socket = this.socket;
		this.socket = undefined;
		this.buffer = "";
		if (socket) {
			socket.removeAllListeners();
			socket.destroy();
		}
	}

	/** Full teardown used by close(): also flips `isConnected` false, unlike
	 * destroySocketHandle() above. */
	private teardownSocket(): void {
		this.destroySocketHandle();
		this.isConnected = false;
	}

	/** Sets `isConnected` true and resets the reconnect backoff - the ONLY
	 * place either happens (Finding 2 / Finding 3). Reached only once a
	 * connection is genuinely usable: either there was nothing to subscribe
	 * to, or herdr actually acknowledged the subscribe. A connection that
	 * establishes and then immediately dies at the subscribe step (Finding
	 * 1's exact repro) therefore never resets `attempt`, so backoff keeps
	 * growing across repeated failures instead of resetting every cycle. */
	private markConnected(): void {
		this.isConnected = true;
		this.attempt = 0;
	}

	/** Flips `isConnected` false and emits "disconnected" - but only if it
	 * was true. Idempotent by design: both ensureConnected()'s catch and
	 * handleDrop() call this, and exactly one of them will find
	 * `isConnected` still true (the other either never set it or already
	 * flipped it), so a genuine transition is reported exactly once no
	 * matter which path gets there first. */
	private markDisconnected(): void {
		if (!this.isConnected) return;
		this.isConnected = false;
		this.emit("disconnected");
	}

	private openSocket(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const socket = net.createConnection(this.options.socketPath);
			socket.setEncoding("utf8");
			this.connectingSocket = socket;
			this.connectingResolve = resolve;

			const onError = (err: Error) => {
				socket.removeAllListeners();
				if (this.connectingSocket === socket) {
					this.connectingSocket = undefined;
					this.connectingResolve = undefined;
				}
				this.scheduleReconnect();
				reject(new Error(`herdr connection failed: ${err.message}`));
			};

			const onConnect = () => {
				socket.removeListener("error", onError);
				if (this.connectingSocket === socket) {
					this.connectingSocket = undefined;
					this.connectingResolve = undefined;
				}

				// close() may have run while this socket was mid-handshake; its
				// own handling above already destroyed/resolved for that case,
				// but this is the last line of defense against adopting a
				// socket as live after an explicit close().
				if (this.closed) {
					socket.removeAllListeners();
					socket.destroy();
					resolve();
					return;
				}

				this.socket = socket;
				this.buffer = "";
				socket.on("data", (chunk: string) => this.onData(chunk));
				socket.on("error", () => {});
				socket.on("close", () => this.handleDrop(socket));

				if (this.reconnectTimer) {
					clearTimeout(this.reconnectTimer);
					this.reconnectTimer = undefined;
				}

				// Deliberately NOT emitting "connected" here, and NOT yet
				// calling markConnected(): whether this transport swap is a
				// reportable lifecycle transition depends on whether the
				// client was already connected before this call started
				// (only ensureConnected(), the sole caller, knows that) - and
				// `isConnected` itself must not flip true until the subscribe
				// step below (if any) has actually succeeded (Finding 3).

				const desired = this.combinedDesired();
				if (desired.length === 0) {
					// Nothing to subscribe to: a bare connection is, by
					// definition, as usable as it's ever going to get.
					this.markConnected();
					resolve();
					return;
				}

				// Re-subscribe with the full desired set immediately, before
				// this connection is considered usable - this is what makes
				// "re-subscribe after every reconnect" true both for a
				// caller-driven resubscribe (doSubscribe's/doReplace's
				// forceReopen path) and for an unplanned drop
				// (scheduleReconnect's timer, which funnels back through
				// here too).
				this.sendSubscribe(desired).then(
					() => {
						this.markConnected();
						resolve();
					},
					(err: Error) => {
						// The subscribe step itself failed - a rejection
						// (Finding 1/4) or an ack timeout (Finding 3). Either
						// way this socket never became genuinely usable, so
						// `isConnected` must stay false and this must not be
						// left half-open: if herdr already closed it (the
						// rejection case - verified live), handleDrop(socket)
						// is a safe, idempotent re-entry (dispatch() already
						// ran its own cleanup, see rejectPendingSubscribe());
						// if herdr did NOT close it (the ack-timeout case,
						// Finding 3's literal scenario - nothing else would
						// ever tear this socket down or schedule a retry),
						// this is what actually does both.
						this.handleDrop(socket);
						reject(err);
					},
				);
			};

			socket.once("error", onError);
			socket.once("connect", onConnect);
		});
	}

	private sendSubscribe(subscriptions: HerdrSubscription[]): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (!this.socket) {
				reject(new Error("herdr event socket not connected"));
				return;
			}
			const id = `sd-${this.nextId++}`;
			this.pendingSubscribeId = id;
			this.pendingSubscribeSnapshot = subscriptions;

			const timeout = setTimeout(() => {
				if (this.pendingSubscribeId !== id) return;
				this.subscribeAckWaiter = undefined;
				this.pendingSubscribeId = undefined;
				this.pendingSubscribeSnapshot = undefined;
				reject(new Error("herdr events.subscribe timed out"));
			}, this.options.requestTimeoutMs ?? 10_000);
			// Don't hold the process open just for this timer.
			timeout.unref?.();

			const wrappedResolve = () => {
				clearTimeout(timeout);
				resolve();
			};
			const wrappedReject = (err: Error) => {
				clearTimeout(timeout);
				reject(err);
			};
			this.subscribeAckWaiter = { resolve: wrappedResolve, reject: wrappedReject };

			this.socket.write(
				JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } }) + "\n",
			);
		});
	}

	/** Idempotent, re-entry-safe teardown for an event connection that has
	 * stopped being usable - whether because herdr closed it (the `socket`
	 * "close" listener calls this with the socket that closed) or because
	 * WE need to tear it down ourselves (the sendSubscribe ack-timeout path
	 * in openSocket(), which passes the same socket so a subsequent natural
	 * "close" event - if herdr does eventually close it too - is a safe
	 * no-op re-entry rather than a double teardown). `socket` is omitted
	 * only by close()'s own explicit teardown, which never calls this. */
	private handleDrop(socket?: net.Socket): void {
		if (this.closed) return;
		if (!this.socket) return; // already handled - idempotent re-entry
		if (socket && this.socket !== socket) return; // stale event for a superseded socket
		const current = this.socket;
		this.socket = undefined;
		this.buffer = "";
		current.removeAllListeners();
		current.destroy();
		if (this.subscribeAckWaiter) {
			const waiter = this.subscribeAckWaiter;
			this.subscribeAckWaiter = undefined;
			this.pendingSubscribeId = undefined;
			this.pendingSubscribeSnapshot = undefined;
			waiter.reject(new Error("herdr event connection dropped"));
		}
		this.markDisconnected();
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.closed || this.reconnectTimer) return;
		const base = this.options.reconnectBaseMs ?? 250;
		const max = this.options.reconnectMaxMs ?? 5000;
		const delay = Math.min(base * 2 ** this.attempt++, max);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			if (this.closed) return;
			this.enqueue(() => this.ensureConnected(false)).catch(() => {
				/* openSocket's own onError path already re-armed scheduleReconnect */
			});
		}, delay);
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let index: number;
		while ((index = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (!line.trim()) continue;

			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				this.emit("parseError", line);
				continue;
			}
			if (!isHerdrFrame(parsed)) {
				this.emit("parseError", line);
				continue;
			}
			this.dispatch(parsed);
		}
	}

	/** Resolves `id` against a subscribe rejection frame's DERIVED id (see
	 * the class comment's "Subscribe-error id derivation" section):
	 * `${pendingSubscribeId}:sub:${index}:probe`. Returns the parsed index,
	 * or undefined if `id` doesn't match that shape at all (including when
	 * there's no pending subscribe to match against). Matches on the
	 * `${pendingSubscribeId}:sub:` PREFIX and parses the following integer
	 * rather than hardcoding the literal `:probe` suffix - see the class
	 * comment for why. */
	private subscribeErrorIndex(id: string): number | undefined {
		if (!this.pendingSubscribeId) return undefined;
		const prefix = `${this.pendingSubscribeId}:sub:`;
		if (!id.startsWith(prefix)) return undefined;
		const rest = id.slice(prefix.length);
		const sep = rest.indexOf(":");
		const idxStr = sep === -1 ? rest : rest.slice(0, sep);
		if (!/^\d+$/.test(idxStr)) return undefined;
		return Number(idxStr);
	}

	private dispatch(message: HerdrResponse): void {
		if (message.id && this.pendingSubscribeId) {
			if (message.id === this.pendingSubscribeId) {
				const waiter = this.subscribeAckWaiter!;
				this.subscribeAckWaiter = undefined;
				this.pendingSubscribeId = undefined;
				this.pendingSubscribeSnapshot = undefined;
				// Never actually observed live (a successful subscribe always
				// echoes the id with no `error`, and a rejected one always
				// carries the DERIVED id handled below instead) - kept as a
				// defensive fallback rather than assumed impossible.
				if (message.error) waiter.reject(new Error(message.error.message));
				else waiter.resolve();
				return;
			}
			const rejectedIndex = this.subscribeErrorIndex(message.id);
			if (rejectedIndex !== undefined) {
				this.rejectPendingSubscribe(rejectedIndex, message.error);
				return;
			}
		}
		// Everything else arriving on the event connection is a pushed event
		// (real herdr events never carry an `id` - see
		// .superpowers/sdd/real-herdr-events.md). Handing the raw frame to
		// listeners rather than interpreting it here keeps this class from
		// needing to know the event payload shape at all; AgentRegistry owns
		// that validation boundary.
		this.emit("event", message);
	}

	/** Finding 1/4: a subscribe rejection identifies exactly one bad entry
	 * (herdr stops at the first invalid subscription in the batch and never
	 * reports the rest - verified live). Looks it up in the snapshot sent
	 * alongside the request, drops it from whichever pool holds it so it's
	 * never resent, tells any listener which one it was (mainly for
	 * observability/tests), and rejects the waiter so the caller's own
	 * promise settles. The connection itself is torn down by whoever calls
	 * this (dispatch() doesn't own that - real herdr closes it right after
	 * sending this frame, which fires the socket's own "close" handler). */
	private rejectPendingSubscribe(index: number, error: { code: string; message: string } | undefined): void {
		const waiter = this.subscribeAckWaiter!;
		const snapshot = this.pendingSubscribeSnapshot;
		this.subscribeAckWaiter = undefined;
		this.pendingSubscribeId = undefined;
		this.pendingSubscribeSnapshot = undefined;

		const rejected = snapshot?.[index];
		if (rejected) {
			this.dropSubscription(subscriptionKey(rejected));
			this.emit("subscriptionRejected", rejected, error);
		}
		waiter.reject(
			new Error(error ? `herdr rejected a subscription: ${error.message}` : "herdr rejected a subscription"),
		);
	}

	/** One connection per call: connect, write the one request, read the one
	 * response, tear the connection down - herdr closes it right after
	 * responding anyway. Entirely independent of the event connection above:
	 * a request failure here never touches `this.isConnected` / never emits
	 * "disconnected", and an event-connection drop never rejects a request
	 * in flight on its own socket. */
	request<T>(method: string, params: Record<string, unknown>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const id = `sd-${this.nextId++}`;
			const socket = net.createConnection(this.options.socketPath);
			socket.setEncoding("utf8");
			let buffer = "";
			let settled = false;

			const timeout = setTimeout(() => {
				settle(() => reject(new Error("herdr request timed out")));
			}, this.options.requestTimeoutMs ?? 10_000);
			timeout.unref?.();

			const settle = (run: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				socket.removeAllListeners();
				socket.destroy();
				run();
			};

			socket.once("error", (err: Error) => {
				// Only ever reachable before a response was read (settle()
				// strips listeners as soon as one is). A connection that never
				// got established (ECONNREFUSED/ENOENT/...) or that errors
				// mid-flight both land here, distinctly worded from the
				// "peer closed cleanly with nothing" case below so a caller
				// that cares can tell "herdr is unreachable" apart from
				// "herdr answered oddly".
				settle(() => reject(new Error(`herdr connection failed: ${err.message}`)));
			});

			socket.once("connect", () => {
				socket.write(JSON.stringify({ id, method, params }) + "\n");
			});

			socket.on("data", (chunk: string) => {
				buffer += chunk;
				let index: number;
				while ((index = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, index);
					buffer = buffer.slice(index + 1);
					if (!line.trim()) continue;

					let parsed: unknown;
					try {
						parsed = JSON.parse(line);
					} catch {
						settle(() => reject(new Error("herdr sent a malformed response")));
						return;
					}
					if (!isHerdrFrame(parsed)) {
						settle(() => reject(new Error("herdr sent a malformed response")));
						return;
					}
					const frame = parsed;
					settle(() => {
						if (frame.error) reject(new Error(frame.error.message));
						else resolve(frame.result as T);
					});
					return;
				}
			});

			socket.once("close", () => {
				settle(() => reject(new Error("herdr closed the connection before responding")));
			});
		});
	}
}
