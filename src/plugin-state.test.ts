import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `@elgato/streamdeck` is mocked wholesale for this test: plugin-state.ts's
// only real dependency on it is `streamDeck.settings.{get,set}GlobalSettings`
// and `streamDeck.logger.warn` - importing the real package pulls in file
// logging and a WebSocket-backed connection singleton, neither of which this
// file's logic (persistence and its coalescing, see Finding 2) needs or
// should depend on to be tested.
const settingsMock = {
	getGlobalSettings: vi.fn(),
	setGlobalSettings: vi.fn(),
};
const loggerMock = {
	warn: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

vi.mock("@elgato/streamdeck", () => ({
	default: { settings: settingsMock, logger: loggerMock },
}));

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/** Fresh module instance per call: `current`/`saveInFlight`/`saveQueued` are
 * private module-level state in plugin-state.ts, so a real "start clean" for
 * each test (and the persistence-round-trip test's simulated restart) needs
 * a new module instance, not just cleared mocks. */
async function freshPluginState() {
	vi.resetModules();
	settingsMock.getGlobalSettings.mockReset().mockResolvedValue({});
	settingsMock.setGlobalSettings.mockReset().mockResolvedValue(undefined);
	loggerMock.warn.mockReset();
	const plugin = await import("./plugin-state.js");
	return { plugin, settingsMock, loggerMock };
}

describe("loadSlots", () => {
	it("leaves a fresh allocator in place when global settings have no persisted slots", async () => {
		const { plugin } = await freshPluginState();
		await plugin.loadSlots();

		plugin.allocator().registerSlot(0);
		plugin.allocator().syncAgents(["w1-1"]);
		expect(plugin.allocator().paneIdForSlot(0)).toBe("w1-1");
	});

	it("restores persisted order into the allocator", async () => {
		const { plugin, settingsMock } = await freshPluginState();
		settingsMock.getGlobalSettings.mockResolvedValue({
			slots: { order: ["w1-1", "w1-2"] },
		});

		await plugin.loadSlots();
		plugin.allocator().registerSlot(0);
		plugin.allocator().registerSlot(1);

		expect(plugin.allocator().slotForPaneId("w1-1")).toBe(0);
		expect(plugin.allocator().slotForPaneId("w1-2")).toBe(1);
	});

	it("logs a warning and starts empty when persisted slot state is malformed, rather than throwing", async () => {
		const { plugin, settingsMock, loggerMock } = await freshPluginState();
		settingsMock.getGlobalSettings.mockResolvedValue({ slots: { order: "not-an-array" } });

		await expect(plugin.loadSlots()).resolves.toBeUndefined();

		expect(loggerMock.warn).toHaveBeenCalledTimes(1);
		plugin.allocator().registerSlot(0);
		plugin.allocator().syncAgents(["w1-1"]);
		expect(plugin.allocator().paneIdForSlot(0)).toBe("w1-1");
	});
});

describe("saveSlots persistence round trip", () => {
	it("persists the allocator's current order and restores it after a simulated restart", async () => {
		const { plugin, settingsMock } = await freshPluginState();
		let persisted: unknown;
		settingsMock.setGlobalSettings.mockImplementation(async (value: unknown) => {
			persisted = value;
		});

		plugin.allocator().registerSlot(0);
		plugin.allocator().registerSlot(1);
		plugin.allocator().syncAgents(["w1-1", "w1-2"]);
		await plugin.saveSlots();

		expect(persisted).toMatchObject({
			slots: { order: ["w1-1", "w1-2"] },
		});

		// Simulated restart: a brand new module instance, whose loadSlots()
		// reads back exactly what the previous instance's saveSlots() wrote.
		const restarted = await freshPluginState();
		restarted.settingsMock.getGlobalSettings.mockResolvedValue(persisted);
		await restarted.plugin.loadSlots();
		restarted.plugin.allocator().registerSlot(0);
		restarted.plugin.allocator().registerSlot(1);

		expect(restarted.plugin.allocator().slotForPaneId("w1-1")).toBe(0);
		expect(restarted.plugin.allocator().slotForPaneId("w1-2")).toBe(1);
	});
});

describe("saveSlots coalescing (Finding 2)", () => {
	it("collapses a burst of overlapping calls into far fewer read-modify-write cycles than calls made", async () => {
		const { plugin, settingsMock } = await freshPluginState();
		plugin.allocator().registerSlot(0);
		plugin.allocator().syncAgents(["w1-1"]);

		const deferreds: Array<{ resolve: (value: unknown) => void }> = [];
		settingsMock.getGlobalSettings.mockImplementation(() => {
			const deferred = createDeferred<unknown>();
			deferreds.push(deferred);
			return deferred.promise;
		});

		// Five calls arrive before the first read-modify-write cycle has even
		// finished reading. A racy implementation issues up to five
		// overlapping getGlobalSettings/setGlobalSettings round trips, any of
		// which can clobber another's write; this one must not.
		const pending = [
			plugin.saveSlots(),
			plugin.saveSlots(),
			plugin.saveSlots(),
			plugin.saveSlots(),
			plugin.saveSlots(),
		];

		// Only the first call's read has actually gone out - the other four
		// were coalesced into "one more cycle is needed" rather than each
		// starting their own.
		expect(settingsMock.getGlobalSettings).toHaveBeenCalledTimes(1);

		deferreds[0]?.resolve({});
		await vi.waitFor(() => expect(settingsMock.setGlobalSettings).toHaveBeenCalledTimes(1));
		// The coalesced calls scheduled exactly one follow-up cycle, which
		// picks up fresh state rather than being dropped.
		await vi.waitFor(() => expect(settingsMock.getGlobalSettings).toHaveBeenCalledTimes(2));

		deferreds[1]?.resolve({});
		await Promise.all(pending);

		expect(settingsMock.setGlobalSettings).toHaveBeenCalledTimes(2);
		expect(settingsMock.setGlobalSettings.mock.calls.length).toBeLessThan(pending.length);
	});

	it("a claim made while a save is in flight is not lost, even though it arrived after getGlobalSettings was read", async () => {
		const { plugin, settingsMock } = await freshPluginState();
		plugin.allocator().registerSlot(0);
		plugin.allocator().registerSlot(1);
		plugin.allocator().syncAgents(["w1-1"]);

		const deferreds: Array<{ resolve: (value: unknown) => void }> = [];
		settingsMock.getGlobalSettings.mockImplementation(() => {
			const deferred = createDeferred<unknown>();
			deferreds.push(deferred);
			return deferred.promise;
		});

		const first = plugin.saveSlots();
		// A second caller arrives (and a new agent appears) while the first
		// cycle's read is still pending - this is exactly the burst
		// agent-slot.ts's renderAll() used to create once per key.
		const second = plugin.saveSlots();
		plugin.allocator().syncAgents(["w1-1", "w1-2"]);

		deferreds[0]?.resolve({});
		await vi.waitFor(() => expect(settingsMock.getGlobalSettings).toHaveBeenCalledTimes(2));
		deferreds[1]?.resolve({});
		await Promise.all([first, second]);

		const lastWrite = settingsMock.setGlobalSettings.mock.calls.at(-1)?.[0];
		expect(lastWrite).toMatchObject({
			slots: { order: ["w1-1", "w1-2"] },
		});
	});
});
