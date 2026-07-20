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

	constructor(private readonly options: HerdrClientOptions) {
		super();
	}

	get connected(): boolean {
		return this.isConnected;
	}

	async connect(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const socket = net.createConnection(this.options.socketPath);
			socket.setEncoding("utf8");

			const onError = (err: Error) => {
				socket.removeListener("connect", onConnect);
				reject(err);
			};
			const onConnect = () => {
				socket.removeListener("error", onError);
				this.socket = socket;
				this.isConnected = true;
				socket.on("data", (chunk: string) => this.onData(chunk));
				socket.on("error", () => {});
				this.emit("connected");
				resolve();
			};

			socket.once("error", onError);
			socket.once("connect", onConnect);
		});
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
		this.isConnected = false;
		this.socket?.destroy();
		this.socket = undefined;
		for (const { reject } of this.pending.values()) {
			reject(new Error("herdr client closed"));
		}
		this.pending.clear();
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
