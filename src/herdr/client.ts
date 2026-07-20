import { EventEmitter } from "node:events";
import net from "node:net";
import type { HerdrResponse, HerdrSubscription } from "./types.js";

export interface HerdrClientOptions {
	socketPath: string;
	reconnectBaseMs?: number;
	reconnectMaxMs?: number;
}

interface Pending {
	resolve: (value: never) => void;
	reject: (reason: Error) => void;
}

export class HerdrClient extends EventEmitter {
	private socket?: net.Socket;
	private buffer = "";
	private pending = new Map<string, Pending>();
	private nextId = 0;
	private isConnected = false;
	private closed = false;
	private attempt = 0;
	private reconnectTimer?: NodeJS.Timeout;
	// The socket for the connect attempt currently in flight (initial connect
	// or a reconnect timer that already fired), tracked separately from
	// `socket` because `socket` is only assigned once onConnect fires. `settle`
	// is that attempt's own promise-executor `resolve`, kept so close() can
	// settle the shared promise below directly - bypassing socket events
	// entirely - once it has stripped the socket's listeners (see
	// settleConnectingOnClose()).
	private connecting?: { socket: net.Socket; settle: () => void };
	// The promise for whichever connect attempt is currently in flight.
	// connect() (and the reconnect-timer path, both via openOnce()) return
	// this SAME promise object to every caller while an attempt is pending,
	// instead of starting a second attempt and rejecting the first. This
	// replaces an earlier "supersede-and-reject" design: rejecting a
	// superseded caller's promise is fine if it's awaited/caught, but
	// realistic defensive code like `client.connect(); await
	// client.connect();` never touches the first promise, so the rejection
	// went unhandled and crashed the process under Node's default
	// --unhandled-rejections=throw. Sharing one promise means every caller
	// observes the same outcome: resolve if it connects, reject only on a
	// genuine connection failure.
	private connectingPromise?: Promise<void>;

	constructor(private readonly options: HerdrClientOptions) {
		super();
	}

	get connected(): boolean {
		return this.isConnected;
	}

	// Not `async`: this must return the exact same Promise object on every
	// call while an attempt is in flight (see openOnce()), not a wrapper
	// promise that merely adopts its state. An `async` method would allocate
	// a fresh wrapper promise per call, and an unhandled rejection on *that*
	// wrapper is exactly the failure mode this fix removes.
	connect(): Promise<void> {
		this.closed = false;
		return this.openOnce();
	}

	private openOnce(): Promise<void> {
		// Important finding fix: if an attempt is already in flight (from an
		// overlapping connect() call, or from a reconnect timer that just
		// fired while a manual connect() was still pending), hand back that
		// same promise instead of starting a second attempt. Both callers
		// then share one outcome, and only one socket is ever created.
		if (this.connectingPromise) return this.connectingPromise;

		const promise = new Promise<void>((resolve, reject) => {
			// Defect 2 guard: never allow two live sockets on one client instance.
			// Detach the prior established socket's listeners and destroy it
			// synchronously (before the new connection even starts) so in-flight
			// data from a stale connection can never reach onData twice, and
			// reset the buffer so a fragment from the dead connection can't
			// splice into the new stream.
			this.detachSocket();

			const socket = net.createConnection(this.options.socketPath);
			socket.setEncoding("utf8");
			this.connecting = { socket, settle: resolve };

			const onError = (err: Error) => {
				socket.removeListener("connect", onConnect);
				if (this.connecting?.socket === socket) this.connecting = undefined;
				this.scheduleReconnect();
				reject(err);
			};
			const onConnect = () => {
				socket.removeListener("error", onError);
				if (this.connecting?.socket === socket) this.connecting = undefined;

				// Finding 1 guard: close() may run while this socket - from the
				// initial connect() or from a reconnect timer that already fired -
				// is still mid-handshake. settleConnectingOnClose()/detachSocket()
				// in close() should normally have already killed it, but this is
				// the last line of defense: never adopt a socket as live once the
				// client has been explicitly closed, even if it manages to finish
				// connecting anyway.
				if (this.closed) {
					socket.removeAllListeners();
					socket.destroy();
					resolve();
					return;
				}

				this.socket = socket;
				this.isConnected = true;
				this.attempt = 0;
				this.buffer = "";
				socket.on("data", (chunk: string) => this.onData(chunk));
				socket.on("error", () => {});
				socket.on("close", () => this.handleDrop());
				this.emit("connected");
				resolve();
			};

			socket.once("error", onError);
			socket.once("connect", onConnect);
		});

		this.connectingPromise = promise;
		// Clear the in-flight marker once this attempt settles, so the next
		// connect() (or fired reconnect timer) starts a fresh attempt rather
		// than reusing a decided outcome forever. Attached with a
		// non-throwing pair of handlers (not `.finally()`, which re-throws
		// and would itself become a second, unhandled rejected promise) so
		// this bookkeeping can never surface as its own unhandled rejection.
		const clearIfCurrent = () => {
			if (this.connectingPromise === promise) this.connectingPromise = undefined;
		};
		promise.then(clearIfCurrent, clearIfCurrent);

		return promise;
	}

	private detachSocket(): void {
		const socket = this.socket;
		this.socket = undefined;
		this.isConnected = false;
		this.buffer = "";
		if (socket) {
			socket.removeAllListeners();
			socket.destroy();
		}
	}

	// close()-during-connect design decision: this RESOLVES the shared
	// in-flight promise rather than rejecting it. A genuine connection
	// failure (bad socket path, refused connection) is still a real error
	// and should reject - that path is unchanged, in onError above. But a
	// close() racing an in-flight attempt is not the connect() call's own
	// failure: the caller didn't do anything wrong, and the client's own
	// onConnect guard already treats "connected anyway after close()" as a
	// non-error (resolve(), not reject()) for the same reason. Rejecting
	// here instead would reintroduce the exact bug this fix removes, just
	// relocated to close(): `client.connect(); client.close();` with the
	// connect() promise never awaited/caught is at least as realistic as the
	// original superseded-connect() case, and a reject here would again be
	// an unhandled rejection for a caller who did nothing wrong. Resolving
	// keeps both close()-interrupt outcomes (destroyed mid-handshake here,
	// or connects-anyway in the onConnect guard) consistent regardless of
	// how far the handshake got when close() ran.
	//
	// connectingPromise is cleared synchronously (not left to the
	// then()-based cleanup in openOnce(), which only runs as a microtask)
	// so that a connect() called immediately after close() - in the same
	// synchronous turn - starts a genuine fresh attempt instead of reusing
	// this decided-by-close() promise.
	private settleConnectingOnClose(): void {
		const connecting = this.connecting;
		this.connecting = undefined;
		this.connectingPromise = undefined;
		if (!connecting) return;
		connecting.socket.removeAllListeners();
		connecting.socket.destroy();
		connecting.settle();
	}

	private handleDrop(): void {
		// Finding 1 guard: once close() has run, a "close" event from a socket
		// that was already being torn down must never re-derive reconnect
		// state or re-emit "disconnected".
		if (this.closed) return;
		if (!this.isConnected) return;
		this.isConnected = false;
		this.socket = undefined;
		this.failPending(new Error("herdr socket disconnected"));
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
			this.openOnce().catch(() => {
				/* scheduleReconnect already queued by openOnce's error path */
			});
		}, delay);
	}

	private failPending(error: Error): void {
		for (const { reject } of this.pending.values()) reject(error);
		this.pending.clear();
	}

	request<T>(method: string, params: Record<string, unknown>): Promise<T> {
		if (!this.socket || !this.isConnected) {
			return Promise.reject(new Error("herdr client is not connected"));
		}
		const id = `sd-${this.nextId++}`;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: never) => void, reject });
			this.socket!.write(JSON.stringify({ id, method, params }) + "\n");
		});
	}

	async subscribe(subscriptions: HerdrSubscription[]): Promise<void> {
		if (subscriptions.length === 0) return;
		await this.request("events.subscribe", { subscriptions });
	}

	close(): void {
		this.closed = true;
		this.isConnected = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		// Finding 1: kill an in-flight connect attempt (initial or a fired
		// reconnect timer) synchronously, not just the already-established
		// socket, so it can never resurrect the client after close().
		this.settleConnectingOnClose();
		this.detachSocket();
		this.failPending(new Error("herdr client closed"));
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let index: number;
		while ((index = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (!line.trim()) continue;

			let message: HerdrResponse;
			try {
				message = JSON.parse(line) as HerdrResponse;
			} catch {
				this.emit("parseError", line);
				continue;
			}
			this.dispatch(message);
		}
	}

	private dispatch(message: HerdrResponse): void {
		const waiter = message.id ? this.pending.get(message.id) : undefined;
		if (waiter) {
			this.pending.delete(message.id!);
			if (message.error) {
				waiter.reject(new Error(message.error.message));
			} else {
				waiter.resolve(message.result as never);
			}
			return;
		}
		this.emit("event", message);
	}
}
