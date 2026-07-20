import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { HerdrRequest } from "./types.js";

type RequestHandler = (req: HerdrRequest) => unknown | undefined;

let counter = 0;

export class FakeHerdrServer {
	private server?: net.Server;
	private sockets = new Set<net.Socket>();
	private handler: RequestHandler = () => undefined;
	private socketPath = "";

	async start(): Promise<string> {
		this.socketPath = path.join(os.tmpdir(), `fake-herdr-${process.pid}-${counter++}.sock`);
		if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);

		this.server = net.createServer((socket) => {
			this.sockets.add(socket);
			socket.on("close", () => this.sockets.delete(socket));
			socket.on("error", () => {});

			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				let index: number;
				while ((index = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, index);
					buffer = buffer.slice(index + 1);
					if (!line.trim()) continue;
					const req = JSON.parse(line) as HerdrRequest;
					const response = this.handler(req);
					if (response !== undefined) {
						socket.write(JSON.stringify(response) + "\n");
					}
				}
			});
		});

		await new Promise<void>((resolve) => this.server!.listen(this.socketPath, resolve));
		return this.socketPath;
	}

	onRequest(handler: RequestHandler): void {
		this.handler = handler;
	}

	get socketCount(): number {
		return this.sockets.size;
	}

	push(event: unknown): void {
		const line = JSON.stringify(event) + "\n";
		for (const socket of this.sockets) socket.write(line);
	}

	pushRaw(line: string): void {
		for (const socket of this.sockets) socket.write(line + "\n");
	}

	dropConnections(): void {
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
	}

	async stop(): Promise<void> {
		this.dropConnections();
		if (this.server) {
			await new Promise<void>((resolve) => this.server!.close(() => resolve()));
			this.server = undefined;
		}
		if (this.socketPath && fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
	}
}
