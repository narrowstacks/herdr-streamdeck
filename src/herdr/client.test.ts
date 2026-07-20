import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "./client.js";
import { FakeHerdrServer } from "./fake-server.js";

// Coverage for HerdrClient.request(): one brand-new connection per call,
// with herdr closing it right after responding (verified against a live
// herdr 0.6.9 server - see "Connection model" in
// docs/superpowers/specs/2026-07-19-streamdeck-agent-alerts-design.md).
// There is no persistent connection to set up first - request() needs
// nothing but a socket path, so none of these tests call connect()/
// subscribe() at all.
describe("HerdrClient request()", () => {
	let server: FakeHerdrServer;
	let client: HerdrClient;

	beforeEach(async () => {
		server = new FakeHerdrServer();
	});

	afterEach(async () => {
		client?.close();
		await server.stop();
	});

	it("resolves with the result of a successful request", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { agents: [] } }));

		client = new HerdrClient({ socketPath });
		const result = await client.request<{ agents: unknown[] }>("agent.list", {});

		expect(result).toEqual({ agents: [] });
	});

	it("rejects when herdr returns a JSON-RPC error", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({
			id: req.id,
			error: { code: "pane_not_found", message: "pane nonexistent not found" },
		}));

		client = new HerdrClient({ socketPath });
		await expect(client.request("agent.focus", { target: "nope" })).rejects.toThrow(
			"pane nonexistent not found",
		);
	});

	it("closes its own connection after a response - each request gets a fresh socket, never reused", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { echoed: req.method } }));

		client = new HerdrClient({ socketPath });
		await client.request("agent.list", {});
		// Real herdr closes the connection after one response; the fake
		// server models this too, so nothing should be left open.
		await new Promise((r) => setTimeout(r, 20));
		expect(server.socketCount).toBe(0);
	});

	it("two concurrent requests each get their own connection and do not cross-talk", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { echoed: req.method } }));

		client = new HerdrClient({ socketPath });
		const [a, b] = await Promise.all([
			client.request<{ echoed: string }>("agent.list", {}),
			client.request<{ echoed: string }>("pane.list", {}),
		]);

		expect(a.echoed).toBe("agent.list");
		expect(b.echoed).toBe("pane.list");
	});

	it("rejects distinctly when the connection cannot be established at all (herdr down)", async () => {
		// Never started - nothing listening on this path.
		client = new HerdrClient({ socketPath: `/tmp/herdr-does-not-exist-${process.pid}.sock` });
		await expect(client.request("agent.list", {})).rejects.toThrow(/herdr connection failed/);
	});

	it("rejects distinctly when the peer closes before sending a full response", async () => {
		const socketPath = await server.start();
		server.onRequest((_req, socket) => {
			// Simulate herdr closing the connection without ever answering -
			// a distinct failure mode from "never connected at all" above.
			socket.end();
			return undefined;
		});

		client = new HerdrClient({ socketPath });
		await expect(client.request("agent.list", {})).rejects.toThrow(/closed the connection before responding/);
	});

	it("rejects on a malformed (non-JSON) response line", async () => {
		const socketPath = await server.start();
		server.onRequest((_req, socket) => {
			socket.write("this is not json\n");
			return undefined;
		});

		client = new HerdrClient({ socketPath });
		await expect(client.request("agent.list", {})).rejects.toThrow(/malformed response/);
	});

	it("rejects on a well-formed JSON response that isn't an object (e.g. a bare null)", async () => {
		const socketPath = await server.start();
		server.onRequest((_req, socket) => {
			socket.write("null\n");
			return undefined;
		});

		client = new HerdrClient({ socketPath });
		await expect(client.request("agent.list", {})).rejects.toThrow(/malformed response/);
	});
});
