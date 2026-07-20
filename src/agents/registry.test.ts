import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "../herdr/client.js";
import { FakeHerdrServer } from "../herdr/fake-server.js";
import { AgentRegistry } from "./registry.js";

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

describe("AgentRegistry", () => {
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

	it("normalizes agent.list into AgentInfo", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => {
			if (req.method === "agent.list") return { id: req.id, result: agentListResult([CLAUDE]) };
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();

		expect(registry.agents).toEqual([
			{
				paneId: "w1-1",
				agent: "claude",
				status: "working",
				cwd: "/work/dorkroom",
				focused: true,
				workspaceId: "w1",
			},
		]);
	});

	it("exposes the focused agent", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => {
			if (req.method === "agent.list") {
				return {
					id: req.id,
					result: agentListResult([
						{ ...CLAUDE, focused: false },
						{ ...CLAUDE, pane_id: "w1-2", cwd: "/work/negpy", focused: true, agent: "codex" },
					]),
				};
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();

		expect(registry.focused?.agent).toBe("codex");
		expect(registry.focused?.paneId).toBe("w1-2");
	});

	it("maps an unrecognized status to unknown", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => {
			if (req.method === "agent.list") {
				return { id: req.id, result: agentListResult([{ ...CLAUDE, agent_status: "wat" }]) };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();

		expect(registry.agents[0].status).toBe("unknown");
	});

	it("picks up a status change on the reconcile tick even with no events", async () => {
		const socketPath = await server.start();
		let status = "working";
		server.onRequest((req) => {
			if (req.method === "agent.list") {
				return { id: req.id, result: agentListResult([{ ...CLAUDE, agent_status: status }]) };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 25 });
		await registry.start();
		expect(registry.agents[0].status).toBe("working");

		status = "blocked";
		await new Promise<void>((resolve) => registry.once("changed", resolve));

		expect(registry.agents[0].status).toBe("blocked");
	});

	it("reports disconnected and empties agents when the socket drops", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => {
			if (req.method === "agent.list") return { id: req.id, result: agentListResult([CLAUDE]) };
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath, reconnectBaseMs: 10_000 });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();
		expect(registry.connected).toBe(true);

		const changed = new Promise<void>((resolve) => registry.once("changed", resolve));
		server.dropConnections();
		await changed;

		expect(registry.connected).toBe(false);
		expect(registry.agents).toEqual([]);
	});

	it("F1: stops reporting a trustworthy live state when agent.list errors while the socket stays open", async () => {
		const socketPath = await server.start();
		let fail = false;
		server.onRequest((req) => {
			if (req.method === "agent.list") {
				if (fail) return { id: req.id, error: { code: "boom", message: "kaboom" } };
				return { id: req.id, result: agentListResult([CLAUDE]) };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 20 });
		await registry.start();
		expect(registry.connected).toBe(true);

		fail = true;
		const changed = new Promise<void>((resolve) => registry.once("changed", resolve));
		await changed;

		// The socket itself never dropped - only the RPC failed - so the
		// underlying client is still "connected". The registry must not
		// report that as a trustworthy live state: its data is stale.
		expect(client.connected).toBe(true);
		expect(registry.connected).toBe(false);
		// Stale data must not keep being served as if it were fresh either.
		expect(registry.agents).toEqual([
			{
				paneId: "w1-1",
				agent: "claude",
				status: "working",
				cwd: "/work/dorkroom",
				focused: true,
				workspaceId: "w1",
			},
		]);
	});

	it("F2: a malformed agent entry does not throw, does not stop the poll loop, and a later good poll still fires changed", async () => {
		const socketPath = await server.start();
		let mode: "good" | "malformed" = "good";
		server.onRequest((req) => {
			if (req.method === "agent.list") {
				if (mode === "malformed") {
					return { id: req.id, result: agentListResult([null as unknown as Record<string, unknown>, "not-an-object" as unknown as Record<string, unknown>]) };
				}
				return { id: req.id, result: agentListResult([CLAUDE]) };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		const unhandledRejections: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandledRejections.push(reason);
		process.on("unhandledRejection", onUnhandled);

		try {
			client = new HerdrClient({ socketPath });
			await client.connect();
			registry = new AgentRegistry(client, { reconcileIntervalMs: 20 });
			await registry.start();
			expect(registry.agents).toHaveLength(1);

			mode = "malformed";
			// Wait long enough for several ticks to have had a chance to run
			// against the malformed payload.
			await new Promise((resolve) => setTimeout(resolve, 80));

			mode = "good";
			const changed = new Promise<void>((resolve) => registry.once("changed", resolve));
			await changed;

			expect(registry.agents[0]?.paneId).toBe("w1-1");
			// Give any microtask-queued unhandled rejection a chance to surface.
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("F3: differs() fires changed on a workspaceId-only change", async () => {
		const socketPath = await server.start();
		let workspaceId = "w1";
		server.onRequest((req) => {
			if (req.method === "agent.list") {
				return { id: req.id, result: agentListResult([{ ...CLAUDE, workspace_id: workspaceId }]) };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 20 });
		await registry.start();
		expect(registry.agents[0].workspaceId).toBe("w1");

		workspaceId = "w2";
		const changed = new Promise<void>((resolve) => registry.once("changed", resolve));
		await changed;

		expect(registry.agents[0].workspaceId).toBe("w2");
	});

	it("round2-F1: connected must not read true until real data has arrived, including right after a reconnect", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => {
			if (req.method === "agent.list") return { id: req.id, result: agentListResult([CLAUDE]) };
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath, reconnectBaseMs: 15, reconnectMaxMs: 15 });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });

		// Constructed but never started: must never read connected before the
		// first successful reconcile, even though the underlying socket is
		// already live.
		expect(registry.connected).toBe(false);

		await registry.start();
		expect(registry.connected).toBe(true);
		expect(registry.agents).toHaveLength(1);

		// Reproduce the reviewer's repro exactly: observe registry.connected
		// synchronously off the client's own "connected" event, the instant the
		// socket comes back up but before reconcile()'s round trip to herdr has
		// resolved.
		let capturedConnected: boolean | undefined;
		let capturedAgentCount: number | undefined;
		client.on("connected", () => {
			capturedConnected = registry.connected;
			capturedAgentCount = registry.agents.length;
		});

		const changedAfterDrop = new Promise<void>((resolve) => registry.once("changed", resolve));
		server.dropConnections();
		await changedAfterDrop;
		expect(registry.connected).toBe(false);
		expect(registry.agents).toEqual([]);

		const changedAfterReconnect = new Promise<void>((resolve) => registry.once("changed", resolve));
		await changedAfterReconnect;

		// At the moment "connected" fired - before the post-reconnect
		// reconcile() had resolved - the registry must NOT have claimed to be
		// live with no data behind it.
		expect(capturedConnected).toBe(false);
		expect(capturedAgentCount).toBe(0);

		// Once the post-reconnect reconcile has actually completed, it's safe
		// to report live again.
		expect(registry.connected).toBe(true);
		expect(registry.agents).toHaveLength(1);
	});

	it.each([
		["an object", {}],
		["a number", 5],
	])(
		"round2-F2/F3: a non-array agents container (%s) does not throw, does not stay connected, and recovers on the next good poll",
		async (_label, malformedAgents) => {
			const socketPath = await server.start();
			let mode: "good" | "malformed" = "malformed";
			server.onRequest((req) => {
				if (req.method === "agent.list") {
					if (mode === "malformed") {
						return { id: req.id, result: { agents: malformedAgents, type: "agent_list" } };
					}
					return { id: req.id, result: agentListResult([CLAUDE]) };
				}
				return { id: req.id, result: { type: "subscription_started" } };
			});

			const unhandledRejections: unknown[] = [];
			const onUnhandled = (reason: unknown) => unhandledRejections.push(reason);
			process.on("unhandledRejection", onUnhandled);

			try {
				client = new HerdrClient({ socketPath });
				await client.connect();
				registry = new AgentRegistry(client, { reconcileIntervalMs: 20 });

				// (a) start() must not reject even though the very first reconcile
				// hits a malformed `agents` container, and the poll loop must
				// still start (scheduleTick() must still run).
				await expect(registry.start()).resolves.toBeUndefined();

				// (b) must not stay "connected" serving stale/no data as if live.
				expect(registry.connected).toBe(false);
				expect(registry.agents).toEqual([]);

				// Let a couple of ticks pass against the same malformed shape to
				// prove the loop is still alive and connected stays false, not
				// wedged true by a throw that skipped the failure path.
				await new Promise((resolve) => setTimeout(resolve, 60));
				expect(registry.connected).toBe(false);

				// (c) a subsequent good poll recovers and fires "changed".
				mode = "good";
				const changed = new Promise<void>((resolve) => registry.once("changed", resolve));
				await changed;

				expect(registry.connected).toBe(true);
				expect(registry.agents).toEqual([
					{
						paneId: "w1-1",
						agent: "claude",
						status: "working",
						cwd: "/work/dorkroom",
						focused: true,
						workspaceId: "w1",
					},
				]);

				await new Promise((resolve) => setTimeout(resolve, 0));
				expect(unhandledRejections).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		},
	);

	it("F4: calling start() twice does not double-register listeners or orphan a timer chain", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => {
			if (req.method === "agent.list") return { id: req.id, result: agentListResult([CLAUDE]) };
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath, reconnectBaseMs: 10_000 });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();
		await registry.start();

		let changedCount = 0;
		registry.on("changed", () => changedCount++);

		server.dropConnections();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(changedCount).toBe(1);
	});
});
