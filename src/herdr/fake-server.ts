import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { HerdrRequest, HerdrResponse } from "./types.js";

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
//
// Bitten a THIRD time (see the eventstream-fix task): this file accepted
// every `events.subscribe` unconditionally, with no concept of which panes
// exist. Real herdr rejects a `pane.agent_status_changed` subscription
// naming a pane it doesn't know about, and closes the connection - verified
// live:
//
//   request:  {"id":"sub1","method":"events.subscribe","params":{"subscriptions":[
//               {"type":"pane.agent_status_changed","pane_id":"dead-pane"}]}}
//   response: {"id":"sub1:sub:0:probe","error":{"code":"internal_error",
//               "message":"failed to decode pane get error"}}, then closed.
//
// `knownPanes` models that. A test declares a pane exists either explicitly
// (addPane()/removePane()) or implicitly by answering `agent.list` with it
// (see maybeRegisterPanesFromAgentList() below) - the latter means the vast
// majority of existing tests, which already drive pane state entirely
// through their `agent.list` handler, need no changes at all: the same
// `pane_id` a test's handler already returns from `agent.list` is
// automatically known to `events.subscribe` too, exactly like the real
// server (where both are backed by the same live pane registry). Only tests
// that subscribe to a pane_id WITHOUT ever going through agent.list (a
// handful of HerdrClient-level tests that call client.subscribe() directly)
// need an explicit addPane() call.
export class FakeHerdrServer {
	private server?: net.Server;
	private sockets = new Set<net.Socket>();
	private subscribedSockets = new Set<net.Socket>();
	private handler: RequestHandler = () => undefined;
	private socketPath = "";
	private knownPanes = new Set<string>();

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

					if (req.method === "events.subscribe") {
						const rejection = this.checkSubscription(req);
						if (rejection) {
							socket.write(JSON.stringify(rejection) + "\n");
							socket.destroy();
							return;
						}
					}

					const response = this.handler(req, socket);
					if (response === undefined) {
						// The handler is deliberately holding this request open
						// (a test wants to answer it manually later) - leave the
						// connection alone rather than closing it out from under
						// that plan.
						continue;
					}
					this.maybeRegisterPanesFromAgentList(req, response);
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

	/** Declares a pane as existing, so a `pane.agent_status_changed`
	 * subscription naming it is accepted rather than rejected - see the
	 * class comment. Most tests never need this: answering `agent.list`
	 * with the pane already does it implicitly (maybeRegisterPanesFromAgentList
	 * below). Use this directly only for tests that subscribe to a pane_id
	 * without ever going through agent.list. */
	addPane(paneId: string): void {
		this.knownPanes.add(paneId);
	}

	/** Declares a pane as no longer existing - the fake-server equivalent of
	 * the pane closing. A subsequent `pane.agent_status_changed` subscribe
	 * naming it will be rejected, same as real herdr. */
	removePane(paneId: string): void {
		this.knownPanes.delete(paneId);
	}

	/** Validates an `events.subscribe` request's `pane.agent_status_changed`
	 * entries against `knownPanes` and, if any names a pane that isn't
	 * known, returns the rejection frame real herdr sends - `undefined`
	 * otherwise (request is fine, proceed to the normal handler path).
	 * Verified live: herdr stops at the FIRST invalid entry in the batch
	 * (never reports more than one in a single frame) and answers with a
	 * DERIVED id - `${requestId}:sub:${index}:probe` - not the request id. */
	private checkSubscription(req: HerdrRequest): HerdrResponse | undefined {
		const subscriptions = (req.params as { subscriptions?: unknown } | undefined)?.subscriptions;
		if (!Array.isArray(subscriptions)) return undefined;
		const badIndex = subscriptions.findIndex((sub) => {
			if (typeof sub !== "object" || sub === null) return false;
			const s = sub as { type?: unknown; pane_id?: unknown };
			return s.type === "pane.agent_status_changed" && !this.knownPanes.has(String(s.pane_id));
		});
		if (badIndex === -1) return undefined;
		return {
			id: `${req.id}:sub:${badIndex}:probe`,
			error: { code: "internal_error", message: "failed to decode pane get error" },
		};
	}

	/** Real herdr's `agent.list` and its pane-existence check (which
	 * `events.subscribe` relies on) are backed by the same live pane
	 * registry - a pane that agent.list reports necessarily exists. Mirrors
	 * that here: any `pane_id` a test's handler answers `agent.list` with
	 * is automatically treated as known, so tests that already model pane
	 * state via their `agent.list` handler (the overwhelming majority) need
	 * no changes to keep working under the new `events.subscribe`
	 * fidelity check. */
	private maybeRegisterPanesFromAgentList(req: HerdrRequest, response: unknown): void {
		if (req.method !== "agent.list") return;
		if (typeof response !== "object" || response === null) return;
		const result = (response as { result?: unknown }).result;
		if (typeof result !== "object" || result === null) return;
		const agents = (result as { agents?: unknown }).agents;
		if (!Array.isArray(agents)) return;
		for (const agent of agents) {
			if (typeof agent !== "object" || agent === null) continue;
			const paneId = (agent as { pane_id?: unknown }).pane_id;
			if (typeof paneId === "string" && paneId.length > 0) this.knownPanes.add(paneId);
		}
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
