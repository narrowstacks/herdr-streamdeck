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
	// `socket` because `socket` is only assigned once onConnect fires. This
	// lets a second overlapping connect() (Finding 2) or close() (Finding 1)
	// reach in and kill an attempt that hasn't resolved yet.
	private connecting?: { socket: net.Socket; reject: (err: Error) => void };

	constructor(private readonly options: HerdrClientOptions) {
		super();
	}

	get connected(): boolean {
		return this.isConnected;
	}

	async connect(): Promise<void> {
		this.closed = false;
		await this.openOnce();
	}

	private openOnce(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			// Defect 2 guard: never allow two live sockets on one client instance.
			// Detach the prior established socket's listeners and destroy it
			// synchronously (before the new connection even starts) so in-flight
			// data from a stale connection can never reach onData twice, and
			// reset the buffer so a fragment from the dead connection can't
			// splice into the new stream.
			this.detachSocket();
			// Finding 2 guard: a socket that is still *connecting* (not yet
			// established) isn't covered by detachSocket() above, since
			// `this.socket` is only assigned once onConnect fires. Without this,
			// two overlapping non-awaited connect() calls each start their own
			// socket and both go on to connect, doubling every pushed message.
			// Superseding here kills the older attempt and rejects its promise
			// so the earlier connect() call settles instead of hanging.
			this.supersedeConnecting(new Error("herdr client: connect() superseded by a newer call"));

			const socket = net.createConnection(this.options.socketPath);
			socket.setEncoding("utf8");
			this.connecting = { socket, reject };

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
				// is still mid-handshake. detachSocket()/supersedeConnecting() in
				// close() should normally have already killed it, but this is the
				// last line of defense: never adopt a socket as live once the
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

	private supersedeConnecting(reason: Error): void {
		const connecting = this.connecting;
		this.connecting = undefined;
		if (!connecting) return;
		connecting.socket.removeAllListeners();
		connecting.socket.destroy();
		connecting.reject(reason);
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
		this.supersedeConnecting(new Error("herdr client closed"));
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
