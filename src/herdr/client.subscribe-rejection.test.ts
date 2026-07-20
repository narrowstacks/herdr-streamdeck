import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "./client.js";
import { FakeHerdrServer } from "./fake-server.js";
import type { HerdrRequest } from "./types.js";

// Findings 2, 3, 4 (Important) - all directly bound up with the Critical
// finding's fix: without Finding 4's id-derivation fix, the client cannot
// even READ a subscribe rejection frame at all, so it has no way to know
// WHICH subscription to drop (Finding 1's backstop). Without Finding 3's
// fix, `connected` can read true with an unsubscribed, dead-in-the-water
// socket. Without Finding 2's fix, a connection that keeps dying at the
// subscribe step hammers the reconnect loop at full speed forever instead
// of backing off.

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("HerdrClient subscribe rejection handling", () => {
	let server: FakeHerdrServer;
	let client: HerdrClient;

	beforeEach(() => {
		server = new FakeHerdrServer();
	});

	afterEach(async () => {
		client?.close();
		await server.stop();
	});

	// Finding 4: verified live that a rejected events.subscribe answers with
	// a DERIVED id (`${requestId}:sub:${index}:probe`), not the request id -
	// so a naive exact-id dispatch (the pre-fix behavior) never even sees
	// the rejection; it falls through to being emitted as a generic "event".
	// Finding 1: the client must use that derived id to identify exactly
	// which subscription was rejected and drop it, so the very next
	// reconnect - which the client schedules automatically - succeeds
	// without ever re-sending the dead one.
	it("Finding 1/4: identifies and drops a rejected subscription by its derived-id index, then recovers", async () => {
		const socketPath = await server.start();
		server.addPane("w1-1"); // w1-2 deliberately never registered - simulates a closed pane
		const seen: HerdrRequest[] = [];
		server.onRequest((req) => {
			seen.push(req);
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath, reconnectBaseMs: 10, reconnectMaxMs: 20 });
		const rejections: Array<{ sub: unknown; error: { code: string; message: string } | undefined }> = [];
		client.on("subscriptionRejected", (sub, error) => rejections.push({ sub, error }));

		await client
			.subscribe([
				{ type: "pane.agent_status_changed", pane_id: "w1-1" },
				{ type: "pane.agent_status_changed", pane_id: "w1-2" },
			])
			.catch(() => {
				/* expected: the first attempt is rejected - see below */
			});

		await waitUntil(() => rejections.length >= 1);
		expect(rejections[0].sub).toEqual({ type: "pane.agent_status_changed", pane_id: "w1-2" });
		expect(rejections[0].error?.code).toBe("internal_error");

		// Self-heals: the automatic reconnect resends the desired set with
		// the bad entry already gone, and this time it succeeds.
		await waitUntil(() => client.connected);
		expect(client.connected).toBe(true);

		const lastSubscribe = [...seen].reverse().find((r) => r.method === "events.subscribe")!;
		expect((lastSubscribe.params as { subscriptions: unknown[] }).subscriptions).toEqual([
			{ type: "pane.agent_status_changed", pane_id: "w1-1" },
		]);
	});

	// Finding 3: `isConnected` was set true BEFORE the subscribe ack was
	// awaited. If the ack never arrives and herdr never closes the socket
	// either (a real possibility the original code didn't guard against),
	// `connected` kept reading true forever with a socket that will never
	// deliver a single push event. It must read false for the entire
	// window a subscribe is outstanding, and stay false if it never
	// resolves.
	it("Finding 3: connected stays false while a subscribe ack is outstanding, even if herdr never closes the socket", async () => {
		const socketPath = await server.start();
		server.addPane("w1-1");
		server.onRequest((req) => {
			if (req.method === "events.subscribe") return undefined; // never ack, never close
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({
			socketPath,
			requestTimeoutMs: 30,
			reconnectBaseMs: 500,
			reconnectMaxMs: 500,
		});
		const attempt = client.subscribe([{ type: "pane.agent_status_changed", pane_id: "w1-1" }]);

		// Immediately after issuing the subscribe (TCP is connected, ack is
		// outstanding): must already read false, not true.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(client.connected).toBe(false);

		// The ack timeout fires with nothing having closed the socket: still
		// false, and the promise settles as a rejection rather than hanging.
		await expect(attempt).rejects.toThrow(/timed out/);
		expect(client.connected).toBe(false);
	});

	// Finding 2: `attempt` (the reconnect backoff counter) reset to 0 in
	// onConnect, which fires BEFORE the subscribe step - so a connection
	// that establishes and then immediately dies at the subscribe step
	// (an ack timeout, here - the same failure shape for every cycle,
	// independent of Finding 1's pane-rejection-specific self-healing)
	// reset backoff on every single cycle, hammering herdr at a fixed
	// short interval forever instead of backing off. It must reset only
	// once a connection is genuinely usable (a real ack, or nothing to
	// subscribe to) - never merely once TCP connects.
	it("Finding 2: reconnect backoff keeps growing across repeated subscribe-step failures, not resetting every cycle", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => {
			if (req.method === "events.subscribe") return undefined; // every attempt dies at this step
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({
			socketPath,
			requestTimeoutMs: 15,
			reconnectBaseMs: 20,
			reconnectMaxMs: 400,
		});
		let disconnectedCount = 0;
		client.on("disconnected", () => disconnectedCount++);

		await client.subscribe([{ type: "pane.created" }]).catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 1000));

		// Pre-fix (attempt resets to 0 in onConnect before the subscribe
		// step that's about to fail): backoff stays pinned near
		// reconnectBaseMs forever, producing roughly 1000/(15+20) ~= 28
		// reconnects in this window. Post-fix, backoff genuinely grows
		// every cycle (20, 40, 80, 160, 320, 400, 400, ...), producing at
		// most about half a dozen.
		expect(disconnectedCount).toBeLessThan(15);
		expect(client.connected).toBe(false);
	});
});
