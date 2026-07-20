import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "./client.js";
import { FakeHerdrServer } from "./fake-server.js";

// connect()/subscribe() must be safe to call more than once on the same
// instance without creating a second live socket or double-processing a
// pushed message - both sequentially and when overlapping calls are never
// awaited before the next one starts.
describe("HerdrClient double connect", () => {
	let server: FakeHerdrServer;
	let client: HerdrClient;

	beforeEach(() => {
		server = new FakeHerdrServer();
	});

	afterEach(async () => {
		client?.close();
		await server.stop();
	});

	it("a second connect() while already connected is a no-op - exactly one live socket, no duplicate event delivery", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { type: "subscription_started" } }));

		client = new HerdrClient({ socketPath });
		await client.subscribe([{ type: "pane.created" }]);
		await client.connect(); // second call on the same, already-connected instance

		expect(server.socketCount).toBe(1);

		const received: unknown[] = [];
		client.on("event", (ev) => received.push(ev));

		server.push({ event: "pane_created", data: { pane: { pane_id: "w1-x" } } });
		await new Promise((r) => setTimeout(r, 50));

		expect(received).toEqual([{ event: "pane_created", data: { pane: { pane_id: "w1-x" } } }]);
	});

	it("does not create two live sockets when connect() is called twice concurrently without awaiting", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { type: "subscription_started" } }));

		client = new HerdrClient({ socketPath });

		// Neither call is awaited before the next starts.
		const first = client.connect();
		const second = client.connect();

		await Promise.all([first, second]);
		await new Promise((r) => setTimeout(r, 50));

		expect(server.socketCount).toBe(1);
	});

	it("does not produce an unhandled rejection when a non-awaited connect() is followed by a second connect()", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { type: "subscription_started" } }));

		client = new HerdrClient({ socketPath });

		const unhandled: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);

		try {
			client.connect(); // deliberately not awaited, not caught
			await client.connect();

			await new Promise((r) => setTimeout(r, 100));
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}

		expect(unhandled).toEqual([]);
	});

	it("does not produce an unhandled rejection when overlapping subscribe() calls are never individually awaited", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { type: "subscription_started" } }));

		client = new HerdrClient({ socketPath });

		const unhandled: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);

		try {
			client.subscribe([{ type: "pane.created" }]); // not awaited
			client.subscribe([{ type: "pane.closed" }]); // not awaited either
			await client.subscribe([{ type: "pane.agent_detected" }]);

			await new Promise((r) => setTimeout(r, 100));
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}

		expect(unhandled).toEqual([]);
		expect(server.socketCount).toBe(1);
	});
});
