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
});
