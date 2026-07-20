import type net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "./client.js";
import { FakeHerdrServer } from "./fake-server.js";

// Finding 1 (Important): scheduleReconnect()/reconnectTimer and manual
// connect()/connectingPromise don't coordinate. A socket drop arms
// reconnectTimer for a backoff delay. If a manual connect() during that
// window succeeds *before* the timer fires, the client is genuinely live -
// but nothing cancels the now-stale timer. When it later fires, openOnce()
// calls detachSocket() unconditionally, destroying the good live socket and
// replacing it with a brand new one, without ever calling failPending() -
// so a request in flight on the good socket is orphaned forever, and
// "connected" fires a spurious second time with no matching "disconnected".
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

	it("does not let a stale reconnect timer tear down a good connection established by a manual connect() during the backoff window", async () => {
		const socketPath = await server.start();

		// Every request except "agent.list" gets an immediate reply. The
		// "agent.list" request's server-side socket is captured instead, so
		// the test can reply to it manually, well after the original stale
		// timer's delay would have elapsed - proving the reply still lands on
		// a live connection rather than being lost to a swapped-out socket.
		let captured: { id: string; socket: net.Socket } | undefined;
		server.onRequest((req, socket) => {
			if (req.method === "agent.list") {
				captured = { id: req.id, socket };
				return undefined;
			}
			return { id: req.id, result: {} };
		});

		client = new HerdrClient({ socketPath, reconnectBaseMs: 300, reconnectMaxMs: 1000 });
		await client.connect();

		let connectCount = 0;
		client.on("connected", () => connectCount++);

		// Drop the connection: this arms reconnectTimer for a 300ms delay.
		server.dropConnections();

		// Manually reconnect mid-backoff, well before the 300ms timer fires.
		await new Promise((r) => setTimeout(r, 20));
		await client.connect();

		expect(connectCount).toBe(1); // the manual reconnect's own "connected"

		const inFlight = client.request<{ ok: boolean }>("agent.list", {});

		// Wait past the ORIGINAL stale timer's 300ms delay (measured from the
		// drop, ~280ms from here) so it would have already fired if unfixed.
		await new Promise((r) => setTimeout(r, 320));

		// (a) no spurious second "connected" from the stale timer resurrecting
		// a new socket.
		expect(connectCount).toBe(1);
		// (b) the connection is still live.
		expect(client.connected).toBe(true);

		// Reply now, deliberately after the stale timer's delay has passed:
		// if the stale timer swapped the socket, this write lands on a
		// closed/discarded server-side socket and is lost.
		expect(captured).toBeDefined();
		captured!.socket.write(JSON.stringify({ id: captured!.id, result: { ok: true } }) + "\n");

		// (c) the request settles rather than hanging forever.
		await expect(inFlight).resolves.toEqual({ ok: true });
	});
});
