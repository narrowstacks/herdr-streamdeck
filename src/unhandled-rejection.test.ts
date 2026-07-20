import { afterEach, describe, expect, it, vi } from "vitest";
import { installUnhandledRejectionNet } from "./unhandled-rejection.js";

describe("installUnhandledRejectionNet", () => {
	afterEach(() => {
		process.removeAllListeners("unhandledRejection");
	});

	it("routes a process unhandledRejection to the supplied logger", () => {
		const log = vi.fn();
		installUnhandledRejectionNet(log);

		const reason = new Error("boom");
		process.emit("unhandledRejection", reason, Promise.reject(reason).catch(() => {}));

		expect(log).toHaveBeenCalledWith(reason);
	});

	it("does not throw or remove other listeners when installed more than once", () => {
		const first = vi.fn();
		const second = vi.fn();
		installUnhandledRejectionNet(first);
		installUnhandledRejectionNet(second);

		const reason = "bad";
		process.emit("unhandledRejection", reason, Promise.reject(reason).catch(() => {}));

		expect(first).toHaveBeenCalledWith(reason);
		expect(second).toHaveBeenCalledWith(reason);
	});
});
