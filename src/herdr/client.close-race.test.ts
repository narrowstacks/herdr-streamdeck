import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "./client.js";
import { FakeHerdrServer } from "./fake-server.js";

// Finding 1 (Critical): close() must be genuinely terminal even when a
// socket is still connecting. `this.socket` is only assigned inside
// openOnce()'s onConnect, so a socket still in the connecting state -
// either from the initial connect() or from a reconnect attempt whose
// backoff timer already fired - was untouched by close(). When that
// in-flight socket later connected, onConnect unconditionally flipped
// isConnected to true and emitted "connected" on a client the caller had
// already explicitly closed, resurrecting a supposedly-dead client.
describe("HerdrClient close race", () => {
	let server: FakeHerdrServer;
	let client: HerdrClient;

	beforeEach(() => {
		server = new FakeHerdrServer();
	});

	afterEach(async () => {
		client?.close();
		await server.stop();
	});

	it("does not resurrect as connected when close() races an in-flight initial connect()", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: {} }));

		client = new HerdrClient({ socketPath, reconnectBaseMs: 20, reconnectMaxMs: 40 });

		let connectedEmitted = false;
		let disconnectedEmitted = false;
		client.on("connected", () => {
			connectedEmitted = true;
		});
		client.on("disconnected", () => {
			disconnectedEmitted = true;
		});

		// Do NOT await: close() must run while the socket is still mid-handshake.
		const connectPromise = client.connect().catch(() => {
			/* superseded/closed rejection is expected and fine */
		});
		client.close();

		// Give the in-flight socket plenty of time to actually finish connecting.
		await new Promise((r) => setTimeout(r, 150));
		await connectPromise;

		expect(client.connected).toBe(false);
		expect(connectedEmitted).toBe(false);
		expect(disconnectedEmitted).toBe(false);
		// The resurrected socket must not be left open on the server either.
		expect(server.socketCount).toBe(0);
	});
});
