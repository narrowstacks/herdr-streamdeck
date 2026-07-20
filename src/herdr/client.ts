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
//  - The event path (connect()/subscribe()): one long-lived connection that
//    sends `events.subscribe` and then only listens. Adding a subscription
//    later (e.g. a newly-discovered pane) cannot be layered onto a live
//    subscribed connection - the verified behavior above means it must
//    close the old connection and open a fresh one, subscribing to the
//    FULL desired set every time. `desiredSubscriptions` is the client's
//    memory of that full set, and is what makes "re-subscribe after every
//    reconnect" (both a manual resubscribe and an unplanned drop) work: any
//    time the event connection is (re)established, if the desired set is
//    non-empty it is sent immediately, before the connection is considered
//    usable.
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

	// The full set of subscriptions the caller wants active, accumulated
	// across every subscribe() call for this client's lifetime (herdr has no
	// unsubscribe). Resent in full every time the event connection is
	// (re)established - see the class comment above.
	private desiredSubscriptions: HerdrSubscription[] = [];
	private desiredKeys = new Set<string>();

	// The single events.subscribe request that can be outstanding on the
	// event connection at a time (never more than one - subscribe() calls
	// are serialized through `opChain` below). Unlike the request path,
	// there is exactly one request "shape" this connection ever sends, so a
	// single waiter slot (not a Map keyed by id) is all correlation needs.
	private subscribeAckWaiter?: { resolve: () => void; reject: (err: Error) => void };
	private pendingSubscribeId?: string;

	// The socket for a connect attempt currently mid-handshake, tracked
	// separately from `socket` (which is only assigned once "connect"
	// fires), so close() can kill it before it ever becomes live. `resolve`
	// is that attempt's own promise-executor resolve, kept so close() can
	// settle it directly (see close()) instead of leaving the queued
	// operation that started it hanging forever.
	private connectingSocket?: net.Socket;
	private connectingResolve?: () => void;

	// Serializes every operation that touches the event connection (manual
	// connect(), subscribe(), and the automatic post-drop reconnect) so none
	// of them can interleave and race each other's view of `socket` /
	// `desiredSubscriptions` / `isConnected`. Each queued task's own
	// success/failure is still observable to its caller via the promise
	// enqueue() returns; only the *chain* itself is swallowed (via the
	// no-throw `.then(ok, ok)` below) so one task's rejection can never
	// leak out as an unhandled rejection on a later, unrelated caller's
	// queued task.
	private opChain: Promise<void> = Promise.resolve();

	constructor(private readonly options: HerdrClientOptions) {
		super();
	}

	/** True only when the long-lived event-stream connection is up. This is
	 * deliberately NOT about whether requests can succeed - the request path
	 * (request()) is fully independent, one connection per call, and works
	 * regardless of this flag. This flag exists so a consumer (AgentRegistry)
	 * can know whether push delivery is currently live, since that's what its
	 * own freshness guarantee depends on. */
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
	 * to; subscribe() alone is sufficient for the common case. */
	connect(): Promise<void> {
		this.closed = false;
		return this.enqueue(() => this.ensureConnected(false));
	}

	/** Adds subscriptions to the desired set and ensures the event
	 * connection reflects the full merged set. If nothing new is being
	 * added and the connection is already up, this is a no-op. If the
	 * connection is already up and subscribed, and something new IS being
	 * added, this closes and reopens the connection (per the verified
	 * constraint that a second events.subscribe on a live subscribed
	 * connection just gets closed) and resubscribes with the full merged
	 * set - never an incremental subscribe on a live connection. */
	subscribe(subscriptions: HerdrSubscription[]): Promise<void> {
		if (subscriptions.length === 0) return Promise.resolve();
		this.closed = false;
		return this.enqueue(() => this.doSubscribe(subscriptions));
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
			waiter.reject(new Error("herdr client closed"));
		}
	}

	private mergeDesired(subscriptions: HerdrSubscription[]): boolean {
		let added = false;
		for (const sub of subscriptions) {
			const key = subscriptionKey(sub);
			if (!this.desiredKeys.has(key)) {
				this.desiredKeys.add(key);
				this.desiredSubscriptions.push(sub);
				added = true;
			}
		}
		return added;
	}

	private async doSubscribe(subscriptions: HerdrSubscription[]): Promise<void> {
		const added = this.mergeDesired(subscriptions);
		await this.ensureConnected(added);
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
			if (wasConnected) {
				// Was genuinely live, and the reopen-to-resubscribe failed: this
				// IS a real loss of connectivity, not an implementation detail,
				// even though nothing "dropped" in the handleDrop() sense.
				// openSocket()'s own onError already called scheduleReconnect()
				// unconditionally, so this only needs to report the transition.
				this.isConnected = false;
				this.emit("disconnected");
			}
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
				this.isConnected = true;
				this.attempt = 0;
				if (this.reconnectTimer) {
					clearTimeout(this.reconnectTimer);
					this.reconnectTimer = undefined;
				}
				this.buffer = "";
				socket.on("data", (chunk: string) => this.onData(chunk));
				socket.on("error", () => {});
				socket.on("close", () => this.handleDrop());

				// Deliberately NOT emitting "connected" here: whether this
				// transport swap is a reportable lifecycle transition depends
				// on whether the client was already connected before this call
				// started, which only ensureConnected() (the sole caller) knows
				// - see its own comment.

				if (this.desiredSubscriptions.length === 0) {
					resolve();
					return;
				}

				// Re-subscribe with the full desired set immediately, before
				// this connection is considered usable - this is what makes
				// "re-subscribe after every reconnect" true both for a
				// caller-driven resubscribe (doSubscribe's forceReopen path)
				// and for an unplanned drop (scheduleReconnect's timer, which
				// funnels back through here too).
				this.sendSubscribe(this.desiredSubscriptions).then(resolve, reject);
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

			const timeout = setTimeout(() => {
				if (this.pendingSubscribeId !== id) return;
				this.subscribeAckWaiter = undefined;
				this.pendingSubscribeId = undefined;
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

	private handleDrop(): void {
		if (this.closed) return;
		if (!this.isConnected) return;
		this.isConnected = false;
		this.socket = undefined;
		this.buffer = "";
		if (this.subscribeAckWaiter) {
			const waiter = this.subscribeAckWaiter;
			this.subscribeAckWaiter = undefined;
			this.pendingSubscribeId = undefined;
			waiter.reject(new Error("herdr event connection dropped"));
		}
		this.emit("disconnected");
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

	private dispatch(message: HerdrResponse): void {
		if (message.id && this.pendingSubscribeId && message.id === this.pendingSubscribeId) {
			const waiter = this.subscribeAckWaiter!;
			this.subscribeAckWaiter = undefined;
			this.pendingSubscribeId = undefined;
			if (message.error) waiter.reject(new Error(message.error.message));
			else waiter.resolve();
			return;
		}
		// Everything else arriving on the event connection is a pushed event
		// (real herdr events never carry an `id` - see
		// .superpowers/sdd/real-herdr-events.md). Handing the raw frame to
		// listeners rather than interpreting it here keeps this class from
		// needing to know the event payload shape at all; AgentRegistry owns
		// that validation boundary.
		this.emit("event", message);
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
