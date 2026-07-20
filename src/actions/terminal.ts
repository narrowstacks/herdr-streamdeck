import { execFile } from "node:child_process";

/**
 * Common macOS terminal app bundle names, as `open -a <name>` expects them
 * (i.e. the bundle's filename without the `.app` suffix, not necessarily its
 * marketing name - e.g. iTerm2's bundle is `iTerm.app`).
 *
 * Only "Ghostty" has been verified against a real running instance on this
 * machine (see `detectRunningTerminals`'s test fixtures, captured from a live
 * `ps -A -o comm=`). The rest are the standard, widely-documented bundle
 * names for these apps' default installs; if a user's install uses a
 * different name, the free-text field in the property inspector still works
 * for it - this list only drives the convenience picker.
 */
export const KNOWN_TERMINALS = [
	"Ghostty",
	"iTerm",
	"Terminal",
	"WezTerm",
	"kitty",
	"Alacritty",
	"Warp",
	"Hyper",
	"Tabby",
] as const;

const MAX_APP_NAME_LENGTH = 100;

/**
 * Control characters, path separators, and shell metacharacters. This is a
 * second, independent layer of defense (see `raiseTerminalApp`'s doc
 * comment for the first): `execFile` with an argument array already cannot
 * be exploited by any of these characters, because there is no shell
 * involved to interpret them. This validator exists so a rejection happens
 * even if some future call site is ever tempted to build a shell string
 * instead.
 */
const UNSAFE_APP_NAME_CHARS = /[\x00-\x1f\x7f\\/;&|`$(){}<>'"^~*?!#]/;

/**
 * Pure function: given the text output of a process listing (e.g.
 * `ps -A -o comm=`), returns which `KNOWN_TERMINALS` appear to be running.
 * Matches on `/<Name>.app/` - the app bundle path segment that macOS's
 * `ps comm` column shows for GUI apps launched via LaunchServices - rather
 * than a bare substring match, so an unrelated process merely containing a
 * terminal's name (e.g. `NotGhostty.app`, or a CLI tool literally called
 * `Warp`) is not mistaken for the terminal itself.
 *
 * No I/O here - the caller (`detectRunningTerminalApps`) does the process
 * listing and hands the text to this function, which is what makes this
 * properly unit-testable without touching the real OS.
 */
export function detectRunningTerminals(psOutput: string): string[] {
	return KNOWN_TERMINALS.filter((name) => psOutput.includes(`/${name}.app/`));
}

/**
 * Validates an app name before it is ever passed to `raiseTerminalApp`.
 * Rejects empty/whitespace-only, overlong, control-character, path-separator,
 * and shell-metacharacter names. See `UNSAFE_APP_NAME_CHARS`'s comment for
 * why this exists alongside (not instead of) the argument-array `execFile`
 * call - defense in depth, not the only defense.
 */
export function isSafeAppName(name: string): boolean {
	if (typeof name !== "string") return false;
	if (name.length === 0 || name.length > MAX_APP_NAME_LENGTH) return false;
	if (name.trim().length === 0) return false;
	return !UNSAFE_APP_NAME_CHARS.test(name);
}

/**
 * Decides whether a `AgentSlotSettings.terminalApp` value should actually be
 * raised, and if so, what name to raise. Pure and side-effect free, so the
 * "should we raise, and what" decision is unit-testable independently of the
 * SDK glue in `agent-slot.ts` that calls it.
 *
 * Blank/absent settings (the default) always resolve to `undefined`, which
 * is what preserves today's behaviour exactly - no terminal app is raised
 * unless the user has explicitly configured one.
 */
export function resolveTerminalAppToRaise(terminalApp: string | undefined): string | undefined {
	if (!terminalApp) return undefined;
	const trimmed = terminalApp.trim();
	if (trimmed.length === 0) return undefined;
	return isSafeAppName(trimmed) ? trimmed : undefined;
}

/**
 * Activates (raises) a macOS app by name.
 *
 * Security: this is the one place in the plugin that turns user-editable
 * settings into an OS command. It calls `execFile` with the command and its
 * arguments as a plain array and no shell involved (`execFile`, not `exec`,
 * and no `shell: true` option) - so a name like `foo; rm -rf ~` is passed to
 * `open` as a single inert argument (an application name `open` will fail to
 * find) rather than ever being interpreted by a shell. `isSafeAppName` is
 * checked here too, as a second, independent layer: even if some future
 * caller skips validating first, this function still refuses to shell out
 * with an unsafe-looking name.
 *
 * Rejects (never throws synchronously) on an unsafe name or when `open`
 * itself fails (e.g. no such app installed). Callers must not let a
 * rejection here prevent or undo whatever already-succeeded action preceded
 * it (see `agent-slot.ts`'s `onKeyDown`), and must attach their own
 * `.catch()` - this function does not swallow errors itself.
 */
export function raiseTerminalApp(name: string): Promise<void> {
	if (!isSafeAppName(name)) {
		return Promise.reject(new Error(`refusing to raise app with unsafe name: ${JSON.stringify(name)}`));
	}
	return new Promise((resolve, reject) => {
		execFile("open", ["-a", name], (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

/**
 * Lists running process command paths via `ps -A -o comm=`, for
 * `detectRunningTerminalApps` to parse. Isolated as its own function purely
 * so the I/O boundary is a single, narrow, mockable seam.
 */
function listRunningProcessCommands(): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("ps", ["-A", "-o", "comm="], { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

/**
 * Runs a real process listing and returns which `KNOWN_TERMINALS` are
 * currently running, for the property inspector's datasource-driven picker
 * (see `AgentSlotAction.onSendToPlugin`). Never rejects - failing to detect
 * running terminals is not fatal to anything, so a `ps` failure degrades to
 * "nothing detected" (an empty picker; free-text entry in the property
 * inspector still works) rather than propagating an error to a caller that
 * has no good way to surface it.
 */
export async function detectRunningTerminalApps(): Promise<string[]> {
	try {
		const output = await listRunningProcessCommands();
		return detectRunningTerminals(output);
	} catch {
		return [];
	}
}
