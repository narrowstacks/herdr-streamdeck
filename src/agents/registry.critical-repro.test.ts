import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "../herdr/client.js";
import { FakeHerdrServer } from "../herdr/fake-server.js";
import { AgentRegistry } from "./registry.js";

// CRITICAL finding: a closed pane permanently bricks the plugin.
//
// `desiredSubscriptions` (pre-fix: an ever-growing, never-pruned history of
// every pane ever seen) is resent in FULL on every event-stream reconnect.
// But herdr rejects a `pane.agent_status_changed` subscription for a pane
// that no longer exists, and closes the connection when it does. So: any
// pane the registry ever subscribed to, once closed, poisons every future
// reconnect forever - the connection dies at the subscribe step, reopens,
// dies again at the same step (same stale pane_id still in the resent set),
// forever. Every key then shows "no herdr" while herdr is perfectly
// healthy. The trigger is completely routine: subscribe to a pane, the
// user closes it, any event-stream reopen (network blip, herdr restart,
// anything).
//
// This is exactly the bug 132 pre-existing tests never caught, because the
// OLD fake-server accepted every events.subscribe unconditionally - it had
// no concept of which panes exist, so it could never model herdr's
// rejection at all. This test runs against the NOW-faithful FakeHerdrServer
// (see fake-server.ts), which does track pane existence and does reject +
// close on an unknown pane_id, with the same derived error id real herdr
// uses. Confirmed to FAIL against the pre-fix client.ts/registry.ts (see
// the eventstream-fix task report for the actual failing output) - this is
// the regression lock for that fix.
function agentListResult(agents: Array<Record<string, unknown>>) {
	return { agents, type: "agent_list" };
}

const CLAUDE = {
	agent: "claude",
	agent_status: "working",
	cwd: "/work/dorkroom",
	focused: true,
	pane_id: "w1-1",
	workspace_id: "w1",
};

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("AgentRegistry Critical: closed-pane subscription must not wedge the event stream", () => {
	let server: FakeHerdrServer;
	let client: HerdrClient;
	let registry: AgentRegistry;

	beforeEach(() => {
		server = new FakeHerdrServer();
	});

	afterEach(async () => {
		registry?.stop();
		client?.close();
		await server.stop();
	});

	it("recovers after the subscribed pane closes and the event stream reopens", async () => {
		const socketPath = await server.start();
		let paneAlive = true;
		server.onRequest((req) => {
			if (req.method === "agent.list") {
				return { id: req.id, result: agentListResult(paneAlive ? [CLAUDE] : []) };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		// Fast backoff so the pre-fix infinite-reconnect-loop failure mode is
		// cheap to observe within the test's timeout rather than genuinely
		// hanging for 5+ seconds like the reviewer's live repro.
		client = new HerdrClient({ socketPath, reconnectBaseMs: 10, reconnectMaxMs: 25 });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();
		expect(registry.agents).toHaveLength(1);
		expect(registry.connected).toBe(true);

		// The pane closes: agent.list stops reporting it, and herdr itself no
		// longer knows it (removePane mirrors herdr's own pane registry - a
		// subscribe naming it will now be rejected, exactly like the live
		// server's "failed to decode pane get error").
		paneAlive = false;
		server.removePane("w1-1");
		const closedChanged = new Promise<void>((resolve) => registry.once("changed", resolve));
		server.push({ data: { pane_id: "w1-1", type: "pane_closed", workspace_id: "w1" }, event: "pane_closed" });
		await closedChanged;
		expect(registry.agents).toHaveLength(0);

		// Any subsequent event-stream reopen - here, an ordinary unplanned
		// drop - must not resend the now-dead pane's subscription and wedge
		// the connection forever. Pre-fix, this is exactly where the
		// reviewer's repro got stuck: "AFTER 5s: client.connected=false
		// registry.connected=false agents=0 reconnect-drops-in-5s=16" and it
		// never recovered.
		server.dropConnections();

		// dropConnections()'s effect is async (the socket's own "close" event
		// has to actually fire) - wait for the drop to be OBSERVED before
		// waiting for recovery, or a `connected` that was already true from
		// before this call (it was: the pane closing alone doesn't drop the
		// socket) would make the recovery check below pass trivially without
		// ever having watched anything actually happen.
		await waitUntil(() => !client.connected);

		await waitUntil(() => registry.connected);
		expect(registry.connected).toBe(true);

		// herdr is healthy again and reports the pane count accurately (0,
		// since it's actually closed) - not stuck reporting stale data, and
		// not stuck disconnected.
		expect(registry.agents).toHaveLength(0);

		// A brand new pane appearing afterward must still work normally -
		// proof the event stream is genuinely healthy, not just technically
		// "connected" while silently broken.
		paneAlive = true;
		server.addPane("w1-1"); // pane reopens with the same id, for simplicity
		const revivedChanged = new Promise<void>((resolve) => registry.once("changed", resolve));
		server.push({
			data: { agent: "claude", pane_id: "w1-1", type: "pane_agent_detected", workspace_id: "w1" },
			event: "pane_agent_detected",
		});
		await revivedChanged;
		expect(registry.agents).toHaveLength(1);
	});
});
