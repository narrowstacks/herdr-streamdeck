import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../herdr/types.js";

// `SingletonAction` in the real SDK reads `this.actions` from a live
// `actionService` that only exists once the plugin is connected to Stream
// Deck - there is no way to construct one in a unit test. This fake base
// class replaces it with a plain array the test controls directly, which is
// enough: everything AgentSlotAction does with `this.actions` is iterate it
// and check `.length === 0`, neither of which depends on the real service.
vi.mock("@elgato/streamdeck", () => {
	class FakeSingletonAction {
		actions: unknown[] = [];
	}
	return {
		default: {
			logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
			ui: { sendToPropertyInspector: vi.fn(async () => {}) },
		},
		action: () => (target: unknown) => target,
		SingletonAction: FakeSingletonAction,
	};
});

// `raiseTerminalApp` and `detectRunningTerminalApps` are the two functions in
// terminal.ts that do real I/O (spawn `open`/`ps`) - they have their own
// dedicated, mocked-at-the-child_process-level tests in terminal.test.ts.
// Here, only those two are replaced with test-controlled fakes; the pure
// decision logic (`resolveTerminalAppToRaise`, `isSafeAppName`,
// `detectRunningTerminals`) stays real, so these tests exercise the actual
// "should we raise, and what" decision `onKeyDown` makes, not a re-mocked
// stand-in for it.
vi.mock("./terminal.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./terminal.js")>();
	const { vi: vitestVi } = await import("vitest");
	return {
		...actual,
		raiseTerminalApp: vitestVi.fn(async () => {}),
		detectRunningTerminalApps: vitestVi.fn(async () => [] as string[]),
	};
});

// plugin-state.js's real module constructs a live HerdrClient/AgentRegistry;
// AgentSlotAction only needs the narrow surface it actually calls
// (registry.on/connected/agents/getByCwd, allocator(), saveSlots(),
// client.request()), so this fake provides exactly that, under the test's
// control, without a herdr socket anywhere nearby. Built inside an async
// factory (rather than closing over outer `const`s) specifically to dodge
// vi.mock's hoisting/TDZ trap - see https://vitest.dev/api/vi.html#vi-mock.
vi.mock("../plugin-state.js", async () => {
	const { EventEmitter } = await import("node:events");
	const { SlotAllocator } = await import("../slots/allocator.js");
	const { vi: vitestVi } = await import("vitest");

	class FakeRegistry extends EventEmitter {
		connected = true;
		agents: AgentInfo[] = [];
		getByCwd(cwd: string): AgentInfo | undefined {
			return this.agents.find((a) => a.cwd === cwd);
		}
	}

	const registry = new FakeRegistry();
	let alloc = new SlotAllocator();
	const saveSlots = vitestVi.fn(async () => {});
	const client = { request: vitestVi.fn(async () => undefined) };

	return {
		registry,
		allocator: () => alloc,
		saveSlots,
		client,
		__resetAllocator: () => {
			alloc = new SlotAllocator();
		},
	};
});

const streamDeckMock = await import("@elgato/streamdeck") as unknown as {
	default: {
		logger: Record<"error" | "warn" | "info" | "debug" | "trace", ReturnType<typeof vi.fn>>;
		ui: { sendToPropertyInspector: ReturnType<typeof vi.fn> };
	};
};
const pluginState = await import("../plugin-state.js") as unknown as {
	registry: import("node:events").EventEmitter & {
		connected: boolean;
		agents: AgentInfo[];
		getByCwd(cwd: string): AgentInfo | undefined;
	};
	allocator: () => import("../slots/allocator.js").SlotAllocator;
	saveSlots: ReturnType<typeof vi.fn>;
	client: { request: ReturnType<typeof vi.fn> };
	__resetAllocator: () => void;
};
const terminalMock = await import("./terminal.js") as unknown as {
	raiseTerminalApp: ReturnType<typeof vi.fn>;
	detectRunningTerminalApps: ReturnType<typeof vi.fn>;
};
const { AgentSlotAction } = await import("./agent-slot.js");

function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
	return {
		paneId: "w1-1",
		agent: "claude",
		status: "blocked",
		cwd: "/work/dorkroom",
		focused: false,
		workspaceId: "w1",
		...overrides,
	};
}

function fakeKey(id: string) {
	return {
		id,
		isKey: () => true,
		getSettings: vi.fn(async () => ({ slotIndex: undefined })),
		setImage: vi.fn(async () => {}),
		setTitle: vi.fn(async () => {}),
		showAlert: vi.fn(async () => {}),
	};
}

async function appear(instance: InstanceType<typeof AgentSlotAction>, key: ReturnType<typeof fakeKey>, slotIndex: number) {
	(instance as unknown as { actions: unknown[] }).actions.push(key);
	await instance.onWillAppear({
		action: key,
		payload: { settings: { slotIndex } },
	} as never);
}

async function flushAsync(rounds = 3): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

beforeEach(() => {
	pluginState.registry.removeAllListeners();
	pluginState.registry.connected = true;
	pluginState.registry.agents = [];
	pluginState.__resetAllocator();
	pluginState.saveSlots.mockClear();
	pluginState.client.request.mockClear();
	(streamDeckMock.default.logger.error as ReturnType<typeof vi.fn>).mockClear();
	streamDeckMock.default.ui.sendToPropertyInspector.mockClear();
	terminalMock.raiseTerminalApp.mockReset();
	terminalMock.raiseTerminalApp.mockResolvedValue(undefined);
	terminalMock.detectRunningTerminalApps.mockReset();
	terminalMock.detectRunningTerminalApps.mockResolvedValue([]);
});

describe("AgentSlotAction wiring", () => {
	it("SAFETY (Finding 1): a rejection from a fire-and-forget render path does not escape as an unhandled rejection", async () => {
		const action = new AgentSlotAction();
		const key = fakeKey("key-1");
		await appear(action, key, 0);

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			// Simulate the render path failing (e.g. a websocket hiccup on
			// setImage) the next time it runs, exactly the shape of failure
			// Finding 1 describes: renderAll() awaits key.setImage(), and
			// nothing upstream of the registry "changed" listener awaits
			// renderAll() itself.
			key.setImage.mockRejectedValueOnce(new Error("boom"));

			pluginState.registry.emit("changed");
			await flushAsync();

			expect(unhandled).toEqual([]);
			// The rejection must go somewhere observable, not be swallowed
			// silently - it should reach the logger.
			expect(streamDeckMock.default.logger.error).toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("SAFETY (Finding 1): a saveSlots() rejection from renderAll's claim path does not escape as an unhandled rejection", async () => {
		const action = new AgentSlotAction();
		const key = fakeKey("key-1");
		await appear(action, key, 0);

		pluginState.saveSlots.mockRejectedValueOnce(new Error("global settings unavailable"));
		pluginState.registry.agents = [agent({ cwd: "/work/dorkroom" })];

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			pluginState.registry.emit("changed");
			await flushAsync();

			expect(unhandled).toEqual([]);
			expect(streamDeckMock.default.logger.error).toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("Finding 3: caches slotIndex from willAppear and never calls key.getSettings() to render", async () => {
		const action = new AgentSlotAction();
		const key = fakeKey("key-1");
		pluginState.registry.agents = [agent({ cwd: "/work/dorkroom", status: "working" })];
		pluginState.allocator().registerSlot(0);
		pluginState.allocator().claim("/work/dorkroom");

		await appear(action, key, 0);
		pluginState.registry.emit("changed");
		await flushAsync();

		expect(key.getSettings).not.toHaveBeenCalled();
		expect(key.setTitle).toHaveBeenCalledWith("claude\ndorkroom");
	});

	it("Finding 3: onDidReceiveSettings updates the cached slotIndex used by later renders", async () => {
		const action = new AgentSlotAction();
		const key = fakeKey("key-1");
		await appear(action, key, 0);

		pluginState.allocator().registerSlot(0);
		pluginState.allocator().registerSlot(1);
		pluginState.allocator().claim("/work/a");
		pluginState.allocator().claim("/work/b");
		pluginState.registry.agents = [agent({ cwd: "/work/b", status: "idle" })];

		await action.onDidReceiveSettings({
			action: key,
			payload: { settings: { slotIndex: 1 } },
		} as never);

		expect(key.setTitle).toHaveBeenLastCalledWith("claude\nb");
	});

	it("SAFETY: renders disconnected, never a live-looking color, once the registry reports disconnected", async () => {
		const action = new AgentSlotAction();
		const key = fakeKey("key-1");
		pluginState.registry.agents = [agent({ cwd: "/work/dorkroom" })];
		pluginState.allocator().registerSlot(0);
		pluginState.allocator().claim("/work/dorkroom");
		await appear(action, key, 0);

		pluginState.registry.connected = false;
		pluginState.registry.emit("changed");
		await flushAsync();

		expect(key.setTitle).toHaveBeenLastCalledWith("no herdr");
	});

	it("claims unassigned agents and calls saveSlots at most once per renderAll pass across multiple keys", async () => {
		const action = new AgentSlotAction();
		const keyA = fakeKey("key-a");
		const keyB = fakeKey("key-b");
		await appear(action, keyA, 0);
		await appear(action, keyB, 1);
		pluginState.saveSlots.mockClear();

		pluginState.registry.agents = [
			agent({ cwd: "/work/a", paneId: "p1" }),
			agent({ cwd: "/work/b", paneId: "p2" }),
		];
		pluginState.registry.emit("changed");
		await flushAsync();

		expect(pluginState.saveSlots).toHaveBeenCalledTimes(1);
	});

	describe("onKeyDown", () => {
		it("focuses the agent occupying the pressed slot", async () => {
			const action = new AgentSlotAction();
			const key = fakeKey("key-1");
			pluginState.allocator().registerSlot(0);
			pluginState.allocator().claim("/work/dorkroom");
			pluginState.registry.agents = [agent({ cwd: "/work/dorkroom", paneId: "pane-7" })];
			await appear(action, key, 0);

			await action.onKeyDown({
				action: key,
				payload: { settings: { slotIndex: 0 } },
			} as never);

			expect(pluginState.client.request).toHaveBeenCalledWith("agent.focus", { target: "pane-7" });
			expect(key.showAlert).not.toHaveBeenCalled();
		});

		it("shows an alert instead of focusing when the slot has no live agent", async () => {
			const action = new AgentSlotAction();
			const key = fakeKey("key-1");
			await appear(action, key, 0);

			await action.onKeyDown({
				action: key,
				payload: { settings: { slotIndex: 0 } },
			} as never);

			expect(pluginState.client.request).not.toHaveBeenCalled();
			expect(key.showAlert).toHaveBeenCalled();
		});

		describe("raising the configured terminal app", () => {
			async function pressWithTerminalApp(terminalApp: string | undefined) {
				const action = new AgentSlotAction();
				const key = fakeKey("key-1");
				pluginState.allocator().registerSlot(0);
				pluginState.allocator().claim("/work/dorkroom");
				pluginState.registry.agents = [agent({ cwd: "/work/dorkroom", paneId: "pane-7" })];
				await appear(action, key, 0);

				await action.onKeyDown({
					action: key,
					payload: { settings: { slotIndex: 0, terminalApp } },
				} as never);

				return key;
			}

			it("raises the configured terminal app after a successful focus", async () => {
				const key = await pressWithTerminalApp("Ghostty");

				expect(pluginState.client.request).toHaveBeenCalledWith("agent.focus", { target: "pane-7" });
				expect(terminalMock.raiseTerminalApp).toHaveBeenCalledWith("Ghostty");
				expect(key.showAlert).not.toHaveBeenCalled();
			});

			it("trims whitespace around a configured terminal app before raising", async () => {
				await pressWithTerminalApp("  Ghostty  ");

				expect(terminalMock.raiseTerminalApp).toHaveBeenCalledWith("Ghostty");
			});

			it("does not raise anything when terminalApp is absent (today's behaviour, unchanged)", async () => {
				await pressWithTerminalApp(undefined);

				expect(terminalMock.raiseTerminalApp).not.toHaveBeenCalled();
			});

			it("does not raise anything when terminalApp is blank", async () => {
				await pressWithTerminalApp("");

				expect(terminalMock.raiseTerminalApp).not.toHaveBeenCalled();
			});

			it("does not raise anything when terminalApp is whitespace-only", async () => {
				await pressWithTerminalApp("   ");

				expect(terminalMock.raiseTerminalApp).not.toHaveBeenCalled();
			});

			it("SAFETY: does not raise a shell-injection-shaped terminalApp value", async () => {
				await pressWithTerminalApp("foo; rm -rf ~");

				expect(terminalMock.raiseTerminalApp).not.toHaveBeenCalled();
			});

			it("does not attempt to raise anything when agent.focus itself fails", async () => {
				const action = new AgentSlotAction();
				const key = fakeKey("key-1");
				pluginState.allocator().registerSlot(0);
				pluginState.allocator().claim("/work/dorkroom");
				pluginState.registry.agents = [agent({ cwd: "/work/dorkroom", paneId: "pane-7" })];
				await appear(action, key, 0);
				pluginState.client.request.mockRejectedValueOnce(new Error("herdr unreachable"));

				await action.onKeyDown({
					action: key,
					payload: { settings: { slotIndex: 0, terminalApp: "Ghostty" } },
				} as never);

				expect(key.showAlert).toHaveBeenCalled();
				expect(terminalMock.raiseTerminalApp).not.toHaveBeenCalled();
			});

			it("SAFETY: a raise failure does not throw, does not undo the successful focus, and does not surface as a false showAlert", async () => {
				terminalMock.raiseTerminalApp.mockRejectedValueOnce(new Error("Unable to find application"));

				const unhandled: unknown[] = [];
				const onUnhandled = (reason: unknown) => unhandled.push(reason);
				process.on("unhandledRejection", onUnhandled);
				try {
					const key = await pressWithTerminalApp("Ghostty");
					await flushAsync();

					expect(unhandled).toEqual([]);
					// Focus already succeeded - a raise failure is a nicety failing,
					// not the primary action, so it must not trigger showAlert().
					expect(key.showAlert).not.toHaveBeenCalled();
					expect(streamDeckMock.default.logger.error).toHaveBeenCalled();
				} finally {
					process.off("unhandledRejection", onUnhandled);
				}
			});
		});
	});
});

describe("AgentSlotAction property inspector datasource", () => {
	it("responds to a getTerminals request with the detected terminals as select items", async () => {
		terminalMock.detectRunningTerminalApps.mockResolvedValueOnce(["Ghostty", "iTerm"]);
		const action = new AgentSlotAction();
		const key = fakeKey("key-1");

		await action.onSendToPlugin?.({
			action: key,
			payload: { event: "getTerminals" },
		} as never);

		expect(streamDeckMock.default.ui.sendToPropertyInspector).toHaveBeenCalledWith({
			event: "getTerminals",
			items: [
				{ label: "Ghostty", value: "Ghostty" },
				{ label: "iTerm", value: "iTerm" },
			],
		});
	});

	it("ignores a sendToPlugin payload for an unrelated event", async () => {
		const action = new AgentSlotAction();
		const key = fakeKey("key-1");

		await action.onSendToPlugin?.({
			action: key,
			payload: { event: "somethingElse" },
		} as never);

		expect(streamDeckMock.default.ui.sendToPropertyInspector).not.toHaveBeenCalled();
		expect(terminalMock.detectRunningTerminalApps).not.toHaveBeenCalled();
	});

	it("SAFETY: does not throw or produce an unhandled rejection when sendToPropertyInspector itself fails", async () => {
		streamDeckMock.default.ui.sendToPropertyInspector.mockRejectedValueOnce(new Error("PI gone"));
		const action = new AgentSlotAction();
		const key = fakeKey("key-1");

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			await action.onSendToPlugin?.({
				action: key,
				payload: { event: "getTerminals" },
			} as never);
			await flushAsync();

			expect(unhandled).toEqual([]);
			expect(streamDeckMock.default.logger.error).toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("AgentSlotAction pulse timer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	it("Finding 3: does not repaint on the pulse tick when nothing is blocked", async () => {
		const action = new AgentSlotAction();
		const key = fakeKey("key-1");
		pluginState.allocator().registerSlot(0);
		pluginState.allocator().claim("/work/dorkroom");
		pluginState.registry.agents = [agent({ cwd: "/work/dorkroom", status: "working" })];
		await appear(action, key, 0);
		key.setImage.mockClear();
		key.setTitle.mockClear();

		await vi.advanceTimersByTimeAsync(500);

		expect(key.setImage).not.toHaveBeenCalled();
	});

	it("repaints on the pulse tick when an agent is blocked", async () => {
		const action = new AgentSlotAction();
		const key = fakeKey("key-1");
		pluginState.allocator().registerSlot(0);
		pluginState.allocator().claim("/work/dorkroom");
		pluginState.registry.agents = [agent({ cwd: "/work/dorkroom", status: "blocked" })];
		await appear(action, key, 0);
		const rendersAfterAppear = key.setImage.mock.calls.length;

		await vi.advanceTimersByTimeAsync(500);

		expect(key.setImage.mock.calls.length).toBeGreaterThan(rendersAfterAppear);
	});
});
