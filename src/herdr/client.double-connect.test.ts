import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "./client.js";
import { FakeHerdrServer } from "./fake-server.js";

// Defect 2: connect() had no guard against being called twice on one instance.
// The first socket's listeners stayed attached alongside the second socket's,
// so a single pushed message got processed twice and the two sockets shared
// one `buffer`, risking corrupt splices under interleaved chunks.
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

	it("does not process a single pushed message twice after connect() is called twice", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: {} }));

		client = new HerdrClient({ socketPath });
		await client.connect();
		await client.connect(); // second call on the same instance

		const received: unknown[] = [];
		client.on("event", (ev) => received.push(ev));

		server.push({ type: "pane.created", pane_id: "w1-x" });
		await new Promise((r) => setTimeout(r, 50));

		expect(received).toEqual([{ type: "pane.created", pane_id: "w1-x" }]);
	});

	it("destroys the prior socket so the server is left with exactly one live connection", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: {} }));

		client = new HerdrClient({ socketPath });
		await client.connect();
		await client.connect();

		await new Promise((r) => setTimeout(r, 50));

		expect(server.socketCount).toBe(1);
	});
});
