import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../herdr/types.js";
import { DEFAULT_KEYMAP } from "../keymap/keymap.js";

// Same rationale as agent-slot.test.ts: SingletonAction's `this.actions`
// needs a live SDK connection in the real package, and nothing in
// ApprovalActionBase reads it - onKeyDown works entirely off the event it's
// given - so only `action` and `SingletonAction` need faking here.
vi.mock("@elgato/streamdeck", () => {
	class FakeSingletonAction {
		actions: unknown[] = [];
	}
	return {
		default: { logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() } },
		action: () => (target: unknown) => target,
		SingletonAction: FakeSingletonAction,
	};
});

vi.mock("../plugin-state.js", async () => {
	const { vi: vitestVi } = await import("vitest");
	const state = {
		connected: true,
		focused: undefined as AgentInfo | undefined,
	};
	return {
		registry: {
			get connected() {
				return state.connected;
			},
			get focused() {
				return state.focused;
			},
			on: vitestVi.fn(), // ApprovalActionBase now subscribes to "changed" in its constructor
		},
		keymapTable: () => undefined,
		client: { request: vitestVi.fn(async () => undefined) },
		__state: state,
	};
});

const pluginState = (await import("../plugin-state.js")) as unknown as {
	__state: { connected: boolean; focused: AgentInfo | undefined };
	client: { request: ReturnType<typeof vi.fn> };
};
const { ApproveAction } = await import("./approve.js");
const { DenyAction } = await import("./deny.js");

const blocked: AgentInfo = {
	paneId: "w1-1",
	agent: "claude",
	status: "blocked",
	cwd: "/work/dorkroom",
	focused: true,
	workspaceId: "w1",
};

function fakeKeyAction() {
	return {
		showAlert: vi.fn(async () => {}),
		showOk: vi.fn(async () => {}),
	};
}

beforeEach(() => {
	pluginState.__state.connected = true;
	pluginState.__state.focused = undefined;
	pluginState.client.request.mockClear();
});

describe("ApproveAction.onKeyDown", () => {
	it("sends the approve keys to the focused agent's pane and shows ok", async () => {
		pluginState.__state.focused = blocked;
		const action = new ApproveAction();
		const key = fakeKeyAction();

		await action.onKeyDown({ action: key, payload: { settings: {} } } as never);

		expect(pluginState.client.request).toHaveBeenCalledWith("pane.send_keys", {
			pane_id: "w1-1",
			keys: DEFAULT_KEYMAP.claude.approve,
		});
		expect(key.showOk).toHaveBeenCalled();
		expect(key.showAlert).not.toHaveBeenCalled();
	});

	it("SAFETY: the blocked interlock - refuses (and alerts) instead of sending keys when the focused agent is not blocked", async () => {
		pluginState.__state.focused = { ...blocked, status: "working" };
		const action = new ApproveAction();
		const key = fakeKeyAction();

		await action.onKeyDown({ action: key, payload: { settings: {} } } as never);

		expect(pluginState.client.request).not.toHaveBeenCalled();
		expect(key.showAlert).toHaveBeenCalled();
	});

	it("SAFETY: refuses when nothing is focused, even if herdr reports connected", async () => {
		pluginState.__state.focused = undefined;
		const action = new ApproveAction();
		const key = fakeKeyAction();

		await action.onKeyDown({ action: key, payload: { settings: {} } } as never);

		expect(pluginState.client.request).not.toHaveBeenCalled();
		expect(key.showAlert).toHaveBeenCalled();
	});

	it("SAFETY: refuses when herdr is disconnected, even with a stale blocked agent in memory", async () => {
		pluginState.__state.connected = false;
		pluginState.__state.focused = blocked;
		const action = new ApproveAction();
		const key = fakeKeyAction();

		await action.onKeyDown({ action: key, payload: { settings: {} } } as never);

		expect(pluginState.client.request).not.toHaveBeenCalled();
		expect(key.showAlert).toHaveBeenCalled();
	});

	it("shows an alert instead of throwing when the herdr request itself fails", async () => {
		pluginState.__state.focused = blocked;
		pluginState.client.request.mockRejectedValueOnce(new Error("herdr closed the connection"));
		const action = new ApproveAction();
		const key = fakeKeyAction();

		await expect(action.onKeyDown({ action: key, payload: { settings: {} } } as never)).resolves.toBeUndefined();

		expect(key.showAlert).toHaveBeenCalled();
		expect(key.showOk).not.toHaveBeenCalled();
	});

	it("honours a per-key override typed in the property inspector", async () => {
		pluginState.__state.focused = blocked;
		const action = new ApproveAction();
		const key = fakeKeyAction();

		await action.onKeyDown({
			action: key,
			payload: { settings: { approveKeys: "y" } },
		} as never);

		expect(pluginState.client.request).toHaveBeenCalledWith("pane.send_keys", {
			pane_id: "w1-1",
			keys: ["y"],
		});
	});
});

describe("DenyAction.onKeyDown", () => {
	it("sends the deny keys to the focused agent's pane and shows ok", async () => {
		pluginState.__state.focused = blocked;
		const action = new DenyAction();
		const key = fakeKeyAction();

		await action.onKeyDown({ action: key, payload: { settings: {} } } as never);

		expect(pluginState.client.request).toHaveBeenCalledWith("pane.send_keys", {
			pane_id: "w1-1",
			keys: DEFAULT_KEYMAP.claude.deny,
		});
		expect(key.showOk).toHaveBeenCalled();
	});

	it("SAFETY: the blocked interlock - refuses when the focused agent is idle", async () => {
		pluginState.__state.focused = { ...blocked, status: "idle" };
		const action = new DenyAction();
		const key = fakeKeyAction();

		await action.onKeyDown({ action: key, payload: { settings: {} } } as never);

		expect(pluginState.client.request).not.toHaveBeenCalled();
		expect(key.showAlert).toHaveBeenCalled();
	});
});
