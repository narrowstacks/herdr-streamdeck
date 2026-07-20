/**
 * Finding 1 (defense-in-depth). Every fire-and-forget call site this plugin
 * creates (agent-slot.ts's `registry.on("changed", ...)` listener, its pulse
 * timer, and its `saveSlots()` calls) now carries its own `.catch()`, so in
 * the steady state this net should never fire. It is installed anyway:
 * under Node >=20, an unhandled rejection defaults to terminating the
 * process, and for a Stream Deck plugin that means every key on the deck
 * going blank - a failure mode wildly disproportionate to almost any bug
 * that could trigger it. A process-wide net that logs and carries on is
 * cheap insurance against the next fire-and-forget call site a future change
 * adds without its own `.catch()` (exactly the class of bug this file's
 * sibling modules - see AgentRegistry's `onConnected`/`onEvent`/`tick()`
 * comments - were already written defensively against). It is deliberately
 * NOT a substitute for handling errors at their source: it exists to turn a
 * process crash into a log line, not to make `.catch()` sites optional.
 *
 * Extracted out of plugin.ts (rather than defined inline) purely so it is
 * unit-testable without booting the real SDK: plugin.ts itself is a
 * top-level-await bootstrap script whose side effects (registering actions,
 * connecting to Stream Deck, loading persisted state) run unconditionally
 * the instant it's imported, which makes it unsuitable to import from a test
 * at all. This function has no side effects of its own beyond the
 * `process.on` call it performs when invoked, so a test can call it directly
 * with a fake logger and assert the wiring without touching plugin.ts.
 */
export function installUnhandledRejectionNet(log: (reason: unknown) => void): void {
	process.on("unhandledRejection", (reason) => log(reason));
}
