import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "./client.js";
import { FakeHerdrServer } from "./fake-server.js";

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

	it("emits disconnected and reports not connected when the socket drops", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: {} }));

		client = new HerdrClient({ socketPath, reconnectBaseMs: 20, reconnectMaxMs: 40 });
		await client.connect();

		const disconnected = new Promise<void>((resolve) => client.once("disconnected", resolve));
		server.dropConnections();
		await disconnected;

		expect(client.connected).toBe(false);
	});

	it("rejects in-flight requests when the socket drops", async () => {
		const socketPath = await server.start();
		server.onRequest(() => undefined); // never respond

		client = new HerdrClient({ socketPath, reconnectBaseMs: 20, reconnectMaxMs: 40 });
		await client.connect();

		const inFlight = client.request("agent.list", {});
		server.dropConnections();

		await expect(inFlight).rejects.toThrow(/disconnected/i);
	});

	it("reconnects automatically and emits connected again", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: {} }));

		client = new HerdrClient({ socketPath, reconnectBaseMs: 20, reconnectMaxMs: 40 });
		await client.connect();

		let connectCount = 0;
		client.on("connected", () => connectCount++);

		server.dropConnections();
		await new Promise((r) => setTimeout(r, 200));

		expect(connectCount).toBeGreaterThanOrEqual(1);
		expect(client.connected).toBe(true);
	});
});
