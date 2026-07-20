import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "./client.js";
import { FakeHerdrServer } from "./fake-server.js";
import type { HerdrRequest } from "./types.js";

describe("HerdrClient event stream", () => {
	let server: FakeHerdrServer;
	let client: HerdrClient;

	beforeEach(() => {
		server = new FakeHerdrServer();
	});

	afterEach(async () => {
		client?.close();
		await server.stop();
	});

	it("sends subscriptions in the params shape herdr requires", async () => {
		const socketPath = await server.start();
		server.addPane("w1-1");
		const seen: HerdrRequest[] = [];
		server.onRequest((req) => {
			seen.push(req);
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.subscribe([
			{ type: "pane.agent_status_changed", pane_id: "w1-1" },
			{ type: "pane.created" },
		]);

		expect(seen).toHaveLength(1);
		expect(seen[0].method).toBe("events.subscribe");
		expect(seen[0].params).toEqual({
			subscriptions: [
				{ type: "pane.agent_status_changed", pane_id: "w1-1" },
				{ type: "pane.created" },
			],
		});
	});

	it("delivers pushed events only once subscribed - a bare connect() never receives them", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { type: "subscription_started" } }));

		client = new HerdrClient({ socketPath });
		await client.connect();

		const received: unknown[] = [];
		client.on("event", (ev) => received.push(ev));

		// Real herdr never pushes to a connection that hasn't sent
		// events.subscribe - the fake server models this too.
		server.push({ event: "pane.created", data: { pane_id: "w1-1" } });
		await new Promise((r) => setTimeout(r, 20));
		expect(received).toEqual([]);

		await client.subscribe([{ type: "pane.created" }]);
		server.push({ event: "pane_created", data: { pane: { pane_id: "w1-1" } } });
		await new Promise((r) => setTimeout(r, 20));
		expect(received).toEqual([{ event: "pane_created", data: { pane: { pane_id: "w1-1" } } }]);
	});

	it("emits unsolicited messages as events rather than resolving requests", async () => {
		const socketPath = await server.start();
		server.addPane("w1-1");
		server.onRequest((req) => ({ id: req.id, result: { type: "subscription_started" } }));

		client = new HerdrClient({ socketPath });
		await client.subscribe([{ type: "pane.agent_status_changed", pane_id: "w1-1" }]);

		const received: unknown[] = [];
		client.on("event", (ev) => received.push(ev));

		server.push({
			event: "pane.agent_status_changed",
			data: { pane_id: "w1-1", agent_status: "blocked" },
		});
		await new Promise((r) => setTimeout(r, 20));

		expect(received).toEqual([
			{ event: "pane.agent_status_changed", data: { pane_id: "w1-1", agent_status: "blocked" } },
		]);
	});

	it("discards a malformed frame and keeps processing later frames", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { type: "subscription_started" } }));

		client = new HerdrClient({ socketPath });
		await client.subscribe([{ type: "pane.created" }]);

		const received: unknown[] = [];
		client.on("event", (ev) => received.push(ev));

		server.pushRaw("this is not json");
		server.push({ event: "pane_created", data: { pane: { pane_id: "w1-2" } } });
		await new Promise((r) => setTimeout(r, 20));

		expect(received).toEqual([{ event: "pane_created", data: { pane: { pane_id: "w1-2" } } }]);
	});

	// This is the core protocol fact this whole rewrite exists to honor
	// (verified against a live herdr 0.6.9 server): a second events.subscribe
	// on an already-subscribed connection closes it. subscribe() must
	// transparently reopen and resend the FULL merged set rather than ever
	// attempting an incremental subscribe on a live connection - and, since
	// this is purely an internal transport detail, it must not surface as a
	// "disconnected"/"connected" pair to a consumer that only cares whether
	// herdr push is available.
	it("adding a subscription to an already-subscribed connection transparently reopens it with the full merged set", async () => {
		const socketPath = await server.start();
		server.addPane("w1-1");
		const seen: HerdrRequest[] = [];
		server.onRequest((req) => {
			seen.push(req);
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		let connectedCount = 0;
		let disconnectedCount = 0;
		client.on("connected", () => connectedCount++);
		client.on("disconnected", () => disconnectedCount++);

		await client.subscribe([{ type: "pane.created" }]);
		expect(seen).toHaveLength(1);

		await client.subscribe([{ type: "pane.agent_status_changed", pane_id: "w1-1" }]);

		// Never an incremental subscribe: the second wire request carries the
		// FULL merged set, sent on a brand-new connection.
		expect(seen).toHaveLength(2);
		expect(seen[1].params).toEqual({
			subscriptions: [{ type: "pane.created" }, { type: "pane.agent_status_changed", pane_id: "w1-1" }],
		});
		// Exactly one connection was live at a time throughout.
		expect(server.socketCount).toBe(1);

		// The reopen is an internal transport detail: a consumer watching
		// "connected"/"disconnected" must see exactly one steady connection,
		// not a spurious drop-and-reconnect pair for every new subscription.
		expect(connectedCount).toBe(1);
		expect(disconnectedCount).toBe(0);

		// A subscription that's already covered is a genuine no-op: no third
		// wire request, no reopen.
		await client.subscribe([{ type: "pane.created" }]);
		expect(seen).toHaveLength(2);
	});

	it("adding subscriptions still delivers events pushed to the new connection", async () => {
		const socketPath = await server.start();
		server.addPane("w1-1");
		server.onRequest((req) => ({ id: req.id, result: { type: "subscription_started" } }));

		client = new HerdrClient({ socketPath });
		await client.subscribe([{ type: "pane.created" }]);
		await client.subscribe([{ type: "pane.agent_status_changed", pane_id: "w1-1" }]);

		const received: unknown[] = [];
		client.on("event", (ev) => received.push(ev));

		server.push({
			event: "pane.agent_status_changed",
			data: { pane_id: "w1-1", agent_status: "working" },
		});
		await new Promise((r) => setTimeout(r, 20));

		expect(received).toEqual([
			{ event: "pane.agent_status_changed", data: { pane_id: "w1-1", agent_status: "working" } },
		]);
	});
});
