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
			// Detach the prior socket's listeners and destroy it synchronously
			// (before the new connection even starts) so in-flight data from a
			// stale connection can never reach onData twice, and reset the
			// buffer so a fragment from the dead connection can't splice into
			// the new stream.
			this.detachSocket();

			const socket = net.createConnection(this.options.socketPath);
			socket.setEncoding("utf8");

			const onError = (err: Error) => {
				socket.removeListener("connect", onConnect);
				this.scheduleReconnect();
				reject(err);
			};
			const onConnect = () => {
				socket.removeListener("error", onError);
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

	private handleDrop(): void {
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
		const socket = this.socket;
		this.socket = undefined;
		socket?.destroy();
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
