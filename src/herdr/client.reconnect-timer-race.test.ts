import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "./client.js";
import { FakeHerdrServer } from "./fake-server.js";

// scheduleReconnect()/reconnectTimer and a manual reconnect don't
// automatically coordinate on their own - a drop arms reconnectTimer for a
// backoff delay, and if a manual reconnect during that window succeeds
// *before* the timer fires, the client is genuinely live again. Nothing
// should let the now-stale timer fire later and tear down that good
// connection to replace it with a redundant new one.
//
// The old version of this test proved "the good connection survives" via a
// request left in flight on it - meaningless now that request() is its own
// one-shot connection, entirely unrelated to the event connection this race
// is about. This version proves the same property (no stale second
// reconnect) via the event connection itself: connectCount stays at 1, and
// a push sent well after the stale timer's original deadline is still
// delivered on the one surviving connection.
describe("HerdrClient reconnect timer race", () => {
	let server: FakeHerdrServer;
	let client: HerdrClient;

	beforeEach(() => {
		server = new FakeHerdrServer();
	});

	afterEach(async () => {
		client?.close();
		await server.stop();
	});

	it("does not let a stale reconnect timer tear down a good connection established by a manual reconnect during the backoff window", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { type: "subscription_started" } }));

		client = new HerdrClient({ socketPath, reconnectBaseMs: 300, reconnectMaxMs: 1000 });
		await client.subscribe([{ type: "pane.created" }]);

		let connectCount = 0;
		client.on("connected", () => connectCount++);

		// Drop the connection: this arms reconnectTimer for a 300ms delay.
		const disconnected = new Promise<void>((resolve) => client.once("disconnected", resolve));
		server.dropConnections();
		await disconnected;

		// Manually reconnect mid-backoff, well before the 300ms timer fires.
		await new Promise((r) => setTimeout(r, 20));
		await client.connect();

		expect(connectCount).toBe(1); // the manual reconnect's own "connected"
		expect(server.socketCount).toBe(1);

		const received: unknown[] = [];
		client.on("event", (ev) => received.push(ev));

		// Wait past the ORIGINAL stale timer's 300ms delay (measured from the
		// drop, ~280ms from here) so it would have already fired if unfixed.
		await new Promise((r) => setTimeout(r, 320));

		// (a) no spurious second "connected" from the stale timer resurrecting
		// a new socket.
		expect(connectCount).toBe(1);
		// (b) the connection is still live, and still exactly one socket.
		expect(client.connected).toBe(true);
		expect(server.socketCount).toBe(1);

		// (c) a push sent now still reaches this connection - if the stale
		// timer had swapped the socket, either this delivery would be lost
		// (pushed to a socket nothing is listening through anymore) or a
		// second, orphaned connection would exist server-side.
		server.push({ event: "pane_created", data: { pane: { pane_id: "w1-late" } } });
		await new Promise((r) => setTimeout(r, 20));
		expect(received).toEqual([{ event: "pane_created", data: { pane: { pane_id: "w1-late" } } }]);
	});
});
