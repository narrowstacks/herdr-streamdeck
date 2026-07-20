import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "./client.js";
import { FakeHerdrServer } from "./fake-server.js";
import type { HerdrRequest } from "./types.js";

describe("HerdrClient events", () => {
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
		const seen: HerdrRequest[] = [];
		server.onRequest((req) => {
			seen.push(req);
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		await client.subscribe([
			{ type: "pane.agent_status_changed", pane_id: "w1-1" },
			{ type: "pane.created" },
		]);

		expect(seen[0].method).toBe("events.subscribe");
		expect(seen[0].params).toEqual({
			subscriptions: [
				{ type: "pane.agent_status_changed", pane_id: "w1-1" },
				{ type: "pane.created" },
			],
		});
	});

	it("emits unsolicited messages as events rather than resolving requests", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: {} }));

		client = new HerdrClient({ socketPath });
		await client.connect();

		const received: unknown[] = [];
		client.on("event", (ev) => received.push(ev));

		server.push({ type: "pane.agent_status_changed", pane_id: "w1-1", status: "blocked" });
		await new Promise((r) => setTimeout(r, 20));

		expect(received).toEqual([
			{ type: "pane.agent_status_changed", pane_id: "w1-1", status: "blocked" },
		]);
	});

	it("discards a malformed frame and keeps processing later frames", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: {} }));

		client = new HerdrClient({ socketPath });
		await client.connect();

		const received: unknown[] = [];
		client.on("event", (ev) => received.push(ev));

		server.pushRaw("this is not json");
		server.push({ type: "pane.created", pane_id: "w1-2" });
		await new Promise((r) => setTimeout(r, 20));

		expect(received).toEqual([{ type: "pane.created", pane_id: "w1-2" }]);
	});
});
