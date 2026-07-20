import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "./client.js";
import { FakeHerdrServer } from "./fake-server.js";
import type { HerdrRequest } from "./types.js";

describe("HerdrClient reconnect", () => {
	let server: FakeHerdrServer;
	let client: HerdrClient;

	beforeEach(() => {
		server = new FakeHerdrServer();
	});

	afterEach(async () => {
		client?.close();
		await server.stop();
	});

	it("emits disconnected and reports not connected when the event connection drops", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { type: "subscription_started" } }));

		client = new HerdrClient({ socketPath, reconnectBaseMs: 20, reconnectMaxMs: 40 });
		await client.subscribe([{ type: "pane.created" }]);

		const disconnected = new Promise<void>((resolve) => client.once("disconnected", resolve));
		server.dropConnections();
		await disconnected;

		expect(client.connected).toBe(false);
	});

	it("reconnects automatically and emits connected again", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { type: "subscription_started" } }));

		client = new HerdrClient({ socketPath, reconnectBaseMs: 20, reconnectMaxMs: 40 });
		await client.subscribe([{ type: "pane.created" }]);

		let connectCount = 0;
		client.on("connected", () => connectCount++);

		server.dropConnections();
		await new Promise((r) => setTimeout(r, 200));

		expect(connectCount).toBeGreaterThanOrEqual(1);
		expect(client.connected).toBe(true);
	});

	// Required behavior (see the design doc's "Connection model"):
	// subscriptions do not survive a new connection, so an unplanned drop
	// must re-subscribe the full desired set, not just reopen a bare socket.
	it("re-subscribes the full desired set after an unplanned drop and reconnect", async () => {
		const socketPath = await server.start();
		server.addPane("w1-1");
		const seen: HerdrRequest[] = [];
		server.onRequest((req) => {
			seen.push(req);
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath, reconnectBaseMs: 10, reconnectMaxMs: 10 });
		await client.subscribe([
			{ type: "pane.created" },
			{ type: "pane.agent_status_changed", pane_id: "w1-1" },
		]);
		expect(seen).toHaveLength(1);

		const connected = new Promise<void>((resolve) => client.once("connected", resolve));
		server.dropConnections();
		await connected;

		expect(seen).toHaveLength(2);
		expect(seen[1].method).toBe("events.subscribe");
		expect(seen[1].params).toEqual({
			subscriptions: [
				{ type: "pane.created" },
				{ type: "pane.agent_status_changed", pane_id: "w1-1" },
			],
		});
	});

	// The whole point of splitting the transport into two paths: a request
	// in flight on its own one-shot connection must be completely unaffected
	// by the event connection dropping, and vice versa. Under the old
	// single-multiplexed-connection design this was impossible to keep true;
	// under the new one it falls out for free because they're different
	// sockets, but it's exactly the kind of assumption worth pinning down
	// with a test rather than trusting to the architecture alone.
	it("a request in flight on its own connection is unaffected by the event connection dropping", async () => {
		const socketPath = await server.start();
		let releaseAgentList: (() => void) | undefined;
		const held = new Promise<void>((resolve) => {
			releaseAgentList = resolve;
		});
		server.onRequest((req, socket) => {
			if (req.method === "agent.list") {
				void held.then(() => socket.write(JSON.stringify({ id: req.id, result: { agents: [] } }) + "\n"));
				return undefined;
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath, reconnectBaseMs: 10, reconnectMaxMs: 10 });
		await client.subscribe([{ type: "pane.created" }]);

		const inFlight = client.request<{ agents: unknown[] }>("agent.list", {});

		const disconnected = new Promise<void>((resolve) => client.once("disconnected", resolve));
		// Only the event (subscribed) connection - the request's own
		// in-flight connection is deliberately left alone, so a resolve
		// after this proves the two paths are actually independent rather
		// than merely both having gone down together.
		server.dropSubscribedConnections();
		await disconnected;
		expect(client.connected).toBe(false);

		releaseAgentList!();
		await expect(inFlight).resolves.toEqual({ agents: [] });
	});
});
