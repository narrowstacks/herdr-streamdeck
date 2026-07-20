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

// Verbatim wire payloads captured from a live herdr 0.6.9 server (protocol
// 13) - see .superpowers/sdd/real-herdr-events.md. The pushed-event handler
// was originally written against an invented `{type, pane_id, agent_status}`
// top-level shape that herdr never actually sends; every event test in this
// file must exercise the REAL shape (`{event, data}`) or it proves nothing.

// The exact bytes from the reference doc, byte-for-byte, against the exact
// pane/workspace ids they were captured with - proves the parser handles the
// literal captured payload, not just a shape that resembles it.
const REAL_CAPTURED_STATUS_CHANGED_BLOCKED = {
	data: {
		agent: "claude",
		agent_status: "blocked",
		pane_id: "w65704613465d81-2",
		workspace_id: "w65704613465d81",
	},
	event: "pane.agent_status_changed",
};

// Same verified structure (dotted `event` name, fields under `data`, no
// `data.type`), parameterized so it can target the `w1-1`/`w1` fixtures the
// rest of this suite (and registry.test.ts) already use.
function statusChangedEvent(paneId: string, status: string, workspaceId = "w1") {
	return {
		data: { agent: "claude", agent_status: status, pane_id: paneId, workspace_id: workspaceId },
		event: "pane.agent_status_changed",
	};
}

// Real captured `pane_created` payload - underscored event name, and pane
// fields nested one level deeper under `data.pane` (unlike every other
// event, whose fields sit directly under `data`).
const REAL_PANE_CREATED = {
	data: {
		pane: {
			agent_status: "unknown",
			cwd: "/Users/aaron/workspace/claude-control-streamdeck",
			focused: false,
			foreground_cwd: "/Users/aaron/workspace/claude-control-streamdeck",
			pane_id: "w65704613465d81-2",
			revision: 0,
			tab_id: "w65704613465d81:1",
			terminal_id: "term_65706ba33ce0425",
			workspace_id: "w65704613465d81",
		},
		type: "pane_created",
	},
	event: "pane_created",
};

// Real captured `pane_closed` payload - underscored event name.
const REAL_PANE_CLOSED = {
	data: { pane_id: "w65704613465d81-2", type: "pane_closed", workspace_id: "w65704613465d81" },
	event: "pane_closed",
};

// Real captured `pane_agent_detected` payload - underscored event name.
const REAL_PANE_AGENT_DETECTED = {
	data: { agent: "claude", pane_id: "w65704613465d81-1", type: "pane_agent_detected", workspace_id: "w65704613465d81" },
	event: "pane_agent_detected",
};

// Never observed on the wire, but the naming table in the reference doc
// requires both spellings be accepted for every event type, not just the
// ones actually captured - a herdr release that settles on the dotted form
// for lifecycle events (or the underscored form for status changes) must not
// silently regress this.
const DOTTED_PANE_CLOSED = {
	data: { pane_id: "w1-1", type: "pane_closed", workspace_id: "w1" },
	event: "pane.closed",
};

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

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

	it("applies a pushed status change without waiting for the reconcile tick (real captured payload)", async () => {
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
		// Real captured shape: {event, data}, not the invented top-level
		// {type, pane_id, agent_status}.
		server.push(statusChangedEvent("w1-1", "blocked"));
		await changed;

		expect(registry.getByPaneId("w1-1")?.status).toBe("blocked");
	});

	it("applies the literal captured pane.agent_status_changed payload end to end", async () => {
		const socketPath = await server.start();
		const CAPTURED_PANE = {
			agent: "claude",
			agent_status: "working",
			cwd: "/work/captured",
			focused: true,
			pane_id: "w65704613465d81-2",
			workspace_id: "w65704613465d81",
		};
		server.onRequest((req) => {
			if (req.method === "agent.list") {
				return { id: req.id, result: { agents: [CAPTURED_PANE], type: "agent_list" } };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();
		expect(registry.getByPaneId("w65704613465d81-2")?.status).toBe("working");

		const changed = new Promise<void>((resolve) => registry.once("changed", resolve));
		// The exact bytes from real-herdr-events.md, unmodified.
		server.push(REAL_CAPTURED_STATUS_CHANGED_BLOCKED);
		await changed;

		expect(registry.getByPaneId("w65704613465d81-2")?.status).toBe("blocked");
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

		server.push(statusChangedEvent("ghost", "blocked"));
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
		server.push(statusChangedEvent("w1-1", "totally-not-a-status"));
		await changed;

		expect(registry.getByPaneId("w1-1")?.status).toBe("unknown");
	});

	it("accepts both the underscored (as-delivered) and dotted spellings of lifecycle events", async () => {
		const socketPath = await server.start();
		let agentListCount = 0;
		server.onRequest((req) => {
			if (req.method === "agent.list") {
				agentListCount++;
				return { id: req.id, result: { agents: [CLAUDE], type: "agent_list" } };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();
		await waitUntil(() => agentListCount >= 1);

		// As actually delivered by herdr: underscored `pane_created`,
		// `pane_closed`, `pane_agent_detected`.
		const beforeUnderscored = agentListCount;
		server.push(REAL_PANE_CREATED);
		await waitUntil(() => agentListCount > beforeUnderscored);

		const beforeUnderscored2 = agentListCount;
		server.push(REAL_PANE_CLOSED);
		await waitUntil(() => agentListCount > beforeUnderscored2);

		const beforeUnderscored3 = agentListCount;
		server.push(REAL_PANE_AGENT_DETECTED);
		await waitUntil(() => agentListCount > beforeUnderscored3);

		// Never observed on the wire, but must still be accepted: a dotted
		// spelling for an event herdr currently only delivers underscored.
		const beforeDotted = agentListCount;
		server.push(DOTTED_PANE_CLOSED);
		await waitUntil(() => agentListCount > beforeDotted);
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
			// object with no `event` at all
			server.push({});
			// `event` present but `data` missing entirely
			server.push({ event: "pane.agent_status_changed" });
			// `event` present but `data` is not an object
			server.push({ event: "pane.agent_status_changed", data: "not an object" });
			// `event` present but `data` is null
			server.push({ event: "pane.agent_status_changed", data: null });
			// pane.agent_status_changed missing pane_id entirely inside data
			server.push({ event: "pane.agent_status_changed", data: { agent_status: "blocked" } });
			// pane.agent_status_changed with a non-string pane_id
			server.push({ event: "pane.agent_status_changed", data: { pane_id: 42, agent_status: "blocked" } });
			// pane.agent_status_changed with a non-string pane_id (object)
			server.push({
				event: "pane.agent_status_changed",
				data: { pane_id: { nested: true }, agent_status: "blocked" },
			});
			// pane.agent_status_changed with a null pane_id
			server.push({ event: "pane.agent_status_changed", data: { pane_id: null, agent_status: "blocked" } });
			// unrecognized event name entirely
			server.push({ event: "pane.something_else", data: { pane_id: "w1-1" } });
			// THE PINNED REGRESSION: a well-formed-looking payload in the OLD,
			// INVENTED top-level shape this handler was originally (wrongly)
			// written against. herdr never actually sends this - it must be
			// rejected, not silently accepted as if it were the real shape.
			server.push({ type: "pane.agent_status_changed", pane_id: "w1-1", agent_status: "blocked" });

			// Give the socket a beat to deliver everything and for any handler
			// to run (and, if unguarded, to throw/crash).
			await new Promise((resolve) => setTimeout(resolve, 30));

			// None of the malformed events should have mutated state: status
			// must still be "working", not "blocked" from any of the malformed
			// payloads above (including the old-shape one), and no new pane
			// should have appeared.
			expect(registry.agents).toHaveLength(1);
			expect(registry.getByPaneId("w1-1")?.status).toBe("working");

			// The event listener must still be alive and functioning after
			// absorbing all of the above - proves nothing wedged or detached.
			const changed = new Promise<void>((resolve) => registry.once("changed", resolve));
			server.push(statusChangedEvent("w1-1", "blocked"));
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
