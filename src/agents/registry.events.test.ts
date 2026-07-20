import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "../herdr/client.js";
import { FakeHerdrServer } from "../herdr/fake-server.js";
import type { HerdrRequest } from "../herdr/types.js";
import { AgentRegistry } from "./registry.js";

const CLAUDE = {
	agent: "claude",
	agent_status: "working",
	cwd: "/work/dorkroom",
	focused: true,
	pane_id: "w1-1",
	workspace_id: "w1",
};

describe("AgentRegistry subscriptions", () => {
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

	it("subscribes per-pane for status changes and globally for pane lifecycle", async () => {
		const socketPath = await server.start();
		const seen: HerdrRequest[] = [];
		server.onRequest((req) => {
			seen.push(req);
			if (req.method === "agent.list") {
				return { id: req.id, result: { agents: [CLAUDE], type: "agent_list" } };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();

		const subs = seen
			.filter((r) => r.method === "events.subscribe")
			.flatMap((r) => (r.params as { subscriptions: Array<Record<string, unknown>> }).subscriptions);

		expect(subs).toContainEqual({ type: "pane.created" });
		expect(subs).toContainEqual({ type: "pane.closed" });
		expect(subs).toContainEqual({ type: "pane.agent_detected" });
		expect(subs).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1-1" });
	});

	it("applies a pushed status change without waiting for the reconcile tick", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => {
			if (req.method === "agent.list") {
				return { id: req.id, result: { agents: [CLAUDE], type: "agent_list" } };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();
		expect(registry.agents[0].status).toBe("working");

		const changed = new Promise<void>((resolve) => registry.once("changed", resolve));
		server.push({
			type: "pane.agent_status_changed",
			pane_id: "w1-1",
			agent_status: "blocked",
		});
		await changed;

		expect(registry.getByPaneId("w1-1")?.status).toBe("blocked");
	});

	it("ignores a status event for an unknown pane", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => {
			if (req.method === "agent.list") {
				return { id: req.id, result: { agents: [CLAUDE], type: "agent_list" } };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();

		server.push({ type: "pane.agent_status_changed", pane_id: "ghost", agent_status: "blocked" });
		await new Promise((r) => setTimeout(r, 20));

		expect(registry.getByPaneId("ghost")).toBeUndefined();
		expect(registry.agents).toHaveLength(1);
	});

	it("does not subscribe twice for the same pane across reconciles", async () => {
		const socketPath = await server.start();
		const seen: HerdrRequest[] = [];
		server.onRequest((req) => {
			seen.push(req);
			if (req.method === "agent.list") {
				return { id: req.id, result: { agents: [CLAUDE], type: "agent_list" } };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 15 });
		await registry.start();
		await new Promise((r) => setTimeout(r, 60));

		const paneSubs = seen
			.filter((r) => r.method === "events.subscribe")
			.flatMap((r) => (r.params as { subscriptions: Array<Record<string, unknown>> }).subscriptions)
			.filter((s) => s.type === "pane.agent_status_changed");

		expect(paneSubs).toHaveLength(1);
	});

	it("maps an unrecognized agent_status on a pushed event to unknown, same as the poll path", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => {
			if (req.method === "agent.list") {
				return { id: req.id, result: { agents: [CLAUDE], type: "agent_list" } };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();

		const changed = new Promise<void>((resolve) => registry.once("changed", resolve));
		server.push({ type: "pane.agent_status_changed", pane_id: "w1-1", agent_status: "totally-not-a-status" });
		await changed;

		expect(registry.getByPaneId("w1-1")?.status).toBe("unknown");
	});

	it("does not throw and does not corrupt state on malformed pushed event payloads", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => {
			if (req.method === "agent.list") {
				return { id: req.id, result: { agents: [CLAUDE], type: "agent_list" } };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		const unhandledRejections: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandledRejections.push(reason);
		process.on("unhandledRejection", onUnhandled);

		try {
			client = new HerdrClient({ socketPath });
			await client.connect();
			registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
			await registry.start();
			expect(registry.agents[0].status).toBe("working");

			// Non-object payloads (null, a bare primitive) reaching the "event"
			// listener directly. These are exercised via client.emit(...) rather
			// than over the wire: HerdrClient.dispatch() (frozen Task 6 code, out
			// of scope here) already crashes on a literal top-level `null` JSON
			// line before it would ever reach an "event" listener - a real gap,
			// but not one this task is allowed to fix. The registry's own event
			// handler must still be defensive independent of that, since nothing
			// about the "event" contract guarantees an object.
			client.emit("event", null);
			client.emit("event", "just a string");
			client.emit("event", 42);
			client.emit("event", ["not", "an", "object"]);

			// Object-shaped malformed payloads delivered over the real wire.
			// object with no `type` at all
			server.push({});
			// pane.agent_status_changed missing pane_id entirely
			server.push({ type: "pane.agent_status_changed" });
			// pane.agent_status_changed with a non-string pane_id
			server.push({ type: "pane.agent_status_changed", pane_id: 42, agent_status: "blocked" });
			// pane.agent_status_changed with a non-string pane_id (object)
			server.push({ type: "pane.agent_status_changed", pane_id: { nested: true }, agent_status: "blocked" });
			// pane.agent_status_changed with a null pane_id
			server.push({ type: "pane.agent_status_changed", pane_id: null, agent_status: "blocked" });
			// unrecognized event type entirely
			server.push({ type: "pane.something_else", pane_id: "w1-1" });

			// Give the socket a beat to deliver everything and for any handler
			// to run (and, if unguarded, to throw/crash).
			await new Promise((resolve) => setTimeout(resolve, 30));

			// None of the malformed events should have mutated state: status
			// must still be "working", not "blocked" from the malformed
			// pane_id: 42 / pane_id: {nested:true} / pane_id: null payloads,
			// and no new pane should have appeared.
			expect(registry.agents).toHaveLength(1);
			expect(registry.getByPaneId("w1-1")?.status).toBe("working");

			// The event listener must still be alive and functioning after
			// absorbing all of the above - proves nothing wedged or detached.
			const changed = new Promise<void>((resolve) => registry.once("changed", resolve));
			server.push({ type: "pane.agent_status_changed", pane_id: "w1-1", agent_status: "blocked" });
			await changed;
			expect(registry.getByPaneId("w1-1")?.status).toBe("blocked");

			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("resets subscription bookkeeping on disconnect and resubscribes the pane after reconnect", async () => {
		const socketPath = await server.start();
		const seen: HerdrRequest[] = [];
		server.onRequest((req) => {
			seen.push(req);
			if (req.method === "agent.list") {
				return { id: req.id, result: { agents: [CLAUDE], type: "agent_list" } };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath, reconnectBaseMs: 10, reconnectMaxMs: 10 });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();

		const paneSubsBefore = seen
			.filter((r) => r.method === "events.subscribe")
			.flatMap((r) => (r.params as { subscriptions: Array<Record<string, unknown>> }).subscriptions)
			.filter((s) => s.type === "pane.agent_status_changed");
		expect(paneSubsBefore).toHaveLength(1);

		const changedAfterDrop = new Promise<void>((resolve) => registry.once("changed", resolve));
		server.dropConnections();
		await changedAfterDrop;

		const changedAfterReconnect = new Promise<void>((resolve) => registry.once("changed", resolve));
		await changedAfterReconnect;
		expect(registry.connected).toBe(true);

		const paneSubsAfter = seen
			.filter((r) => r.method === "events.subscribe")
			.flatMap((r) => (r.params as { subscriptions: Array<Record<string, unknown>> }).subscriptions)
			.filter((s) => s.type === "pane.agent_status_changed");

		// Subscriptions do not survive a reconnect on the herdr side, so the
		// registry must have re-sent the per-pane subscription once the pane
		// reappeared via the post-reconnect reconcile - not just relied on
		// the pre-drop subscription that the new socket never actually saw.
		expect(paneSubsAfter).toHaveLength(2);
	});
});
