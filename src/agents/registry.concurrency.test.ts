import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type net from "node:net";
import { HerdrClient } from "../herdr/client.js";
import { FakeHerdrServer } from "../herdr/fake-server.js";
import type { HerdrRequest } from "../herdr/types.js";
import { AgentRegistry } from "./registry.js";

// Round 4 findings: reconcile() has no fewer than four unsynchronized call
// sites (tick()'s timer, onConnected, and a fire-and-forget call per pushed
// lifecycle event), and nothing guarantees their agent.list round trips
// resolve in the order they were sent. These tests reproduce the reviewer's
// exact repro for the Critical finding (a stale in-flight reconcile
// reverting a `blocked` pane back to `working` and announcing it via
// "changed") and the Important finding that shares its root cause
// (subscribeNewPanes() de-dup getting bypassed by the same unsynchronized
// concurrency). Every test here was run against the pre-fix code first and
// observed to fail for the reason it claims to guard against - see the task
// report for the actual failing output.

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

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe("AgentRegistry reconcile concurrency", () => {
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

	it("Critical repro: a stale in-flight reconcile must not clobber a fresher one", async () => {
		const socketPath = await server.start();
		// The 1st agent.list is the startup reconcile from registry.start().
		// The 2nd is reconcile A, triggered by lifecycle push A below - held
		// open, simulating the slower of the two overlapping round trips. The
		// 3rd+ is reconcile B, triggered by lifecycle push B - answered
		// immediately with the true current state ("blocked"), simulating the
		// faster round trip that actually lands first.
		let agentListCount = 0;
		let heldReq: HerdrRequest | undefined;
		let heldSocket: net.Socket | undefined;
		server.onRequest((req, socket) => {
			if (req.method === "agent.list") {
				agentListCount++;
				if (agentListCount === 1) {
					return { id: req.id, result: agentListResult([CLAUDE]) };
				}
				if (agentListCount === 2) {
					heldReq = req;
					heldSocket = socket;
					return undefined;
				}
				return { id: req.id, result: agentListResult([{ ...CLAUDE, agent_status: "blocked" }]) };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();
		expect(registry.agents[0].status).toBe("working");

		// Lifecycle push A -> reconcile #2, held.
		server.push({ type: "pane.created" });
		await waitUntil(() => agentListCount >= 2);
		expect(heldReq).toBeDefined();

		// Lifecycle push B -> reconcile #3, answered immediately with
		// "blocked" - the true current state. The registry must pick this up.
		server.push({ type: "pane.created" });
		await waitUntil(() => registry.getByPaneId("w1-1")?.status === "blocked");

		let sawRevert = false;
		registry.on("changed", () => {
			if (registry.getByPaneId("w1-1")?.status === "working") sawRevert = true;
		});

		// Now release the held stale response - the pre-change "working"
		// snapshot, taken before reconcile B's "blocked" landed. It must be
		// discarded, not applied, and must not announce a revert via
		// "changed".
		heldSocket!.write(JSON.stringify({ id: heldReq!.id, result: agentListResult([CLAUDE]) }) + "\n");
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(registry.getByPaneId("w1-1")?.status).toBe("blocked");
		expect(sawRevert).toBe(false);
	});

	it("Important repro: two rapid lifecycle events produce only one subscribe for a given pane_id", async () => {
		const socketPath = await server.start();
		const seen: HerdrRequest[] = [];
		let agentListCount = 0;
		let heldReq: HerdrRequest | undefined;
		let heldSocket: net.Socket | undefined;
		const NEWPANE = { ...CLAUDE, pane_id: "w1-2", cwd: "/work/new" };
		server.onRequest((req, socket) => {
			seen.push(req);
			if (req.method === "agent.list") {
				agentListCount++;
				if (agentListCount === 1) {
					return { id: req.id, result: agentListResult([CLAUDE]) };
				}
				if (agentListCount === 2) {
					heldReq = req;
					heldSocket = socket;
					return undefined;
				}
				return { id: req.id, result: agentListResult([CLAUDE, NEWPANE]) };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();

		server.push({ type: "pane.created" });
		await waitUntil(() => agentListCount >= 2);
		expect(heldReq).toBeDefined();

		server.push({ type: "pane.created" });
		await waitUntil(() => registry.getByPaneId("w1-2") !== undefined);

		heldSocket!.write(
			JSON.stringify({ id: heldReq!.id, result: agentListResult([CLAUDE, NEWPANE]) }) + "\n",
		);
		await new Promise((resolve) => setTimeout(resolve, 100));

		const subscribeCallsForNewPane = seen
			.filter((r) => r.method === "events.subscribe")
			.flatMap((r) => (r.params as { subscriptions: Array<Record<string, unknown>> }).subscriptions)
			.filter((s) => s.pane_id === "w1-2");

		expect(subscribeCallsForNewPane).toHaveLength(1);
	});

	it("Important repro: a superseded reconcile's own snapshot must never reach subscribeNewPanes", async () => {
		const socketPath = await server.start();
		const seen: HerdrRequest[] = [];
		let agentListCount = 0;
		let heldReq: HerdrRequest | undefined;
		let heldSocket: net.Socket | undefined;
		// A's own (stale) snapshot sees w1-2, a pane that, by the time A's
		// held response is released, is no longer part of reality. B's (the
		// fresher, later-triggered) snapshot sees w1-3 instead, never w1-2.
		// This is what makes the assertion below discriminate: if the stale
		// reconcile ever reaches subscribeNewPanes() with its own byPaneId,
		// it sends a genuine, avoidable events.subscribe for w1-2 - a pane
		// nothing fresher ever believed existed.
		const STALE_ONLY_PANE = { ...CLAUDE, pane_id: "w1-2", cwd: "/work/stale" };
		const FRESH_ONLY_PANE = { ...CLAUDE, pane_id: "w1-3", cwd: "/work/fresh" };
		server.onRequest((req, socket) => {
			seen.push(req);
			if (req.method === "agent.list") {
				agentListCount++;
				if (agentListCount === 1) {
					return { id: req.id, result: agentListResult([CLAUDE]) };
				}
				if (agentListCount === 2) {
					heldReq = req;
					heldSocket = socket;
					return undefined;
				}
				return { id: req.id, result: agentListResult([CLAUDE, FRESH_ONLY_PANE]) };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();

		server.push({ type: "pane.created" });
		await waitUntil(() => agentListCount >= 2);
		expect(heldReq).toBeDefined();

		server.push({ type: "pane.created" });
		await waitUntil(() => registry.getByPaneId("w1-3") !== undefined);

		// Release A's held response now, carrying a snapshot the newer
		// reconcile never saw and that reality has already moved past.
		heldSocket!.write(
			JSON.stringify({ id: heldReq!.id, result: agentListResult([CLAUDE, STALE_ONLY_PANE]) }) + "\n",
		);
		await new Promise((resolve) => setTimeout(resolve, 100));

		// The registry must still reflect the newer reconcile's world, not
		// have been overwritten by the stale one.
		expect(registry.getByPaneId("w1-3")).toBeDefined();
		expect(registry.getByPaneId("w1-2")).toBeUndefined();

		const subscribeCallsForStalePane = seen
			.filter((r) => r.method === "events.subscribe")
			.flatMap((r) => (r.params as { subscriptions: Array<Record<string, unknown>> }).subscriptions)
			.filter((s) => s.pane_id === "w1-2");

		expect(subscribeCallsForStalePane).toHaveLength(0);
	});
});
