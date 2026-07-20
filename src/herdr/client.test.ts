import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "./client.js";
import { FakeHerdrServer } from "./fake-server.js";

describe("HerdrClient", () => {
	let server: FakeHerdrServer;
	let client: HerdrClient;

	beforeEach(async () => {
		server = new FakeHerdrServer();
	});

	afterEach(async () => {
		client?.close();
		await server.stop();
	});

	it("resolves a request with the result matching its id", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { agents: [] } }));

		client = new HerdrClient({ socketPath });
		await client.connect();

		const result = await client.request<{ agents: unknown[] }>("agent.list", {});

		expect(result).toEqual({ agents: [] });
	});

	it("rejects a request when herdr returns an error", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({
			id: req.id,
			error: { code: "pane_not_found", message: "pane nonexistent not found" },
		}));

		client = new HerdrClient({ socketPath });
		await client.connect();

		await expect(client.request("agent.focus", { target: "nope" })).rejects.toThrow(
			"pane nonexistent not found",
		);
	});

	it("correlates concurrent requests to the correct callers", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { echoed: req.method } }));

		client = new HerdrClient({ socketPath });
		await client.connect();

		const [a, b] = await Promise.all([
			client.request<{ echoed: string }>("agent.list", {}),
			client.request<{ echoed: string }>("pane.list", {}),
		]);

		expect(a.echoed).toBe("agent.list");
		expect(b.echoed).toBe("pane.list");
	});
});
