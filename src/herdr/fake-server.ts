import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { HerdrRequest } from "./types.js";

type RequestHandler = (req: HerdrRequest, socket: net.Socket) => unknown | undefined;

let counter = 0;

// A faithful model of real herdr's socket behavior (verified against a live
// herdr 0.6.9 server, protocol 13 - see the "Connection model" section of
// docs/superpowers/specs/2026-07-19-streamdeck-agent-alerts-design.md and
// .superpowers/sdd/real-herdr-events.md):
//
//   - Every connection gets EXACTLY ONE request served, then the server
//     closes it - EXCEPT `events.subscribe`, which turns the connection
//     into a one-way event stream that stays open indefinitely.
//   - Sending any further request on an already-subscribed connection gets
//     it closed, with no response at all (verified directly: no error
//     frame, just an immediate close).
//   - Pushed events only ever reach subscribed connections, never a
//     connection that hasn't sent events.subscribe.
//
// The original version of this file held every connection open and served
// unlimited requests on it, i.e. modeled the OLD (wrong) assumption about
// the protocol. Every test built on it exercised that fiction rather than
// the real server - this is what let the transport bug hide behind 99
// passing tests. Fidelity here now matters more than almost anything else
// in this test suite.
export class FakeHerdrServer {
	private server?: net.Server;
	private sockets = new Set<net.Socket>();
	private subscribedSockets = new Set<net.Socket>();
	private handler: RequestHandler = () => undefined;
	private socketPath = "";

	async start(): Promise<string> {
		this.socketPath = path.join(os.tmpdir(), `fake-herdr-${process.pid}-${counter++}.sock`);
		if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);

		this.server = net.createServer((socket) => {
			this.sockets.add(socket);
			socket.on("close", () => {
				this.sockets.delete(socket);
				this.subscribedSockets.delete(socket);
			});
			socket.on("error", () => {});

			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				let index: number;
				while ((index = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, index);
					buffer = buffer.slice(index + 1);
					if (!line.trim()) continue;

					// Verified live: a request arriving on a connection that has
					// already subscribed gets the connection closed, no response.
					if (this.subscribedSockets.has(socket)) {
						socket.destroy();
						return;
					}

					const req = JSON.parse(line) as HerdrRequest;
					const response = this.handler(req, socket);
					if (response === undefined) {
						// The handler is deliberately holding this request open
						// (a test wants to answer it manually later) - leave the
						// connection alone rather than closing it out from under
						// that plan.
						continue;
					}
					socket.write(JSON.stringify(response) + "\n");
					if (req.method === "events.subscribe") {
						this.subscribedSockets.add(socket);
						// Stays open indefinitely as an event stream - never closed.
					} else {
						// Real herdr serves exactly one request per connection.
						socket.end();
						return;
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

	get subscribedSocketCount(): number {
		return this.subscribedSockets.size;
	}

	/** Delivers a pushed event to every currently-subscribed connection, same
	 * as real herdr (a connection that never sent events.subscribe never
	 * receives anything unsolicited). */
	push(event: unknown): void {
		const line = JSON.stringify(event) + "\n";
		for (const socket of this.subscribedSockets) socket.write(line);
	}

	pushRaw(line: string): void {
		for (const socket of this.subscribedSockets) socket.write(line + "\n");
	}

	dropConnections(): void {
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		this.subscribedSockets.clear();
	}

	/** Drops only subscribed (event-stream) connections, leaving any
	 * in-flight one-shot request connections untouched. Lets a test prove
	 * the two transport paths are genuinely independent, rather than merely
	 * both happening to go down together. */
	dropSubscribedConnections(): void {
		for (const socket of this.subscribedSockets) {
			socket.destroy();
			this.sockets.delete(socket);
		}
		this.subscribedSockets.clear();
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
