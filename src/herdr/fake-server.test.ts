import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHerdrServer } from "./fake-server.js";

// FakeHerdrServer's fidelity to the real protocol is the single most
// important thing in this test suite (see the class comment in
// fake-server.ts): the original version of this file modeled a persistent,
// multiplexing connection that real herdr never had, and every HerdrClient/
// AgentRegistry test built on it exercised that fiction instead of the real
// server. These tests talk to raw sockets directly - the same way the live
// herdr server was originally probed (see
// docs/superpowers/specs/2026-07-19-streamdeck-agent-alerts-design.md,
// "Connection model") - to verify the fake server reproduces the exact
// verified facts, independent of whatever HerdrClient itself does with them.
function connect(socketPath: string): net.Socket {
	const socket = net.createConnection(socketPath);
	socket.setEncoding("utf8");
	return socket;
}

function readLines(socket: net.Socket): { lines: string[]; closed: Promise<void> } {
	const lines: string[] = [];
	let buffer = "";
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		let index: number;
		while ((index = buffer.indexOf("\n")) >= 0) {
			lines.push(buffer.slice(0, index));
			buffer = buffer.slice(index + 1);
		}
	});
	const closed = new Promise<void>((resolve) => socket.once("close", resolve));
	return { lines, closed };
}

describe("FakeHerdrServer protocol fidelity", () => {
	let server: FakeHerdrServer;

	beforeEach(() => {
		server = new FakeHerdrServer();
	});

	afterEach(async () => {
		await server.stop();
	});

	it("closes the connection after serving one non-subscribe request", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: {} }));

		const socket = connect(socketPath);
		const { lines, closed } = readLines(socket);
		await new Promise<void>((resolve) => socket.once("connect", resolve));

		socket.write(JSON.stringify({ id: "1", method: "agent.list", params: {} }) + "\n");
		await closed;

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual({ id: "1", result: {} });
	});

	it("keeps a connection open indefinitely after events.subscribe", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { type: "subscription_started" } }));

		const socket = connect(socketPath);
		await new Promise<void>((resolve) => socket.once("connect", resolve));
		socket.write(
			JSON.stringify({ id: "s1", method: "events.subscribe", params: { subscriptions: [{ type: "pane.created" }] } }) +
				"\n",
		);

		let closed = false;
		socket.once("close", () => {
			closed = true;
		});
		await new Promise((r) => setTimeout(r, 100));

		expect(closed).toBe(false);
		expect(server.subscribedSocketCount).toBe(1);
		socket.destroy();
	});

	it("closes a subscribed connection if a further request arrives on it - the exact live-verified behavior", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { type: "subscription_started" } }));

		const socket = connect(socketPath);
		const { lines, closed } = readLines(socket);
		await new Promise<void>((resolve) => socket.once("connect", resolve));

		socket.write(
			JSON.stringify({ id: "s1", method: "events.subscribe", params: { subscriptions: [{ type: "pane.created" }] } }) +
				"\n",
		);
		await new Promise((r) => setTimeout(r, 20));
		expect(lines).toHaveLength(1); // the subscribe ack

		// Verified live: sending a second request on an already-subscribed
		// connection gets it closed, with no response frame at all - not an
		// error reply, just an immediate close.
		socket.write(JSON.stringify({ id: "s2", method: "events.subscribe", params: { subscriptions: [] } }) + "\n");
		await closed;

		expect(lines).toHaveLength(1); // no second response was ever sent
	});

	it("only delivers pushed events to subscribed connections", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { type: "subscription_started" } }));

		const bystander = connect(socketPath);
		const { lines: bystanderLines } = readLines(bystander);
		await new Promise<void>((resolve) => bystander.once("connect", resolve));
		// Never sends anything - a bare, unsubscribed connection.

		const subscriber = connect(socketPath);
		const { lines: subscriberLines } = readLines(subscriber);
		await new Promise<void>((resolve) => subscriber.once("connect", resolve));
		subscriber.write(
			JSON.stringify({ id: "s1", method: "events.subscribe", params: { subscriptions: [{ type: "pane.created" }] } }) +
				"\n",
		);
		await new Promise((r) => setTimeout(r, 20));

		server.push({ event: "pane_created", data: { pane: { pane_id: "w1-1" } } });
		await new Promise((r) => setTimeout(r, 20));

		expect(bystanderLines).toEqual([]);
		expect(subscriberLines.map((l) => JSON.parse(l))).toContainEqual({
			event: "pane_created",
			data: { pane: { pane_id: "w1-1" } },
		});

		bystander.destroy();
		subscriber.destroy();
	});
});
