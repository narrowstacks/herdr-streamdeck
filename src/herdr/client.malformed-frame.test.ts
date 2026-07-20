import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "./client.js";
import { FakeHerdrServer } from "./fake-server.js";

// Table-driven coverage for every JSON scalar/array shape that parses
// successfully (so the existing try/catch around JSON.parse never fires)
// but is not a valid protocol frame (a non-null object). `null` is the
// specific hole this suite was written to close: `JSON.parse("null")`
// returns `null` with no throw, and the old `dispatch()` did
// `message.id` unconditionally, which threw `TypeError: Cannot read
// properties of null (reading 'id')` synchronously inside the socket's
// "data" handler - an uncaught exception outside of any try/catch, capable
// of taking down the whole plugin process. The other shapes (number,
// string, boolean, array) already survived pre-fix, since `.id` on any of
// those is merely `undefined`, not a throw; they're included here so the
// fix is verified as a boundary validation (any non-null-object frame is
// malformed) rather than a `=== null` special case.
const MALFORMED_FRAMES: Array<{ name: string; raw: string }> = [
	{ name: "null", raw: "null" },
	{ name: "bare number", raw: "42" },
	{ name: "bare string", raw: '"just a string"' },
	{ name: "boolean", raw: "true" },
	{ name: "array", raw: "[1,2,3]" },
];

describe("HerdrClient malformed-frame boundary", () => {
	let server: FakeHerdrServer;
	let client: HerdrClient;

	beforeEach(() => {
		server = new FakeHerdrServer();
	});

	afterEach(async () => {
		client?.close();
		await server.stop();
	});

	it.each(MALFORMED_FRAMES)(
		"discards a $name frame without throwing, keeps the connection alive, still processes later frames, and leaves in-flight requests unaffected",
		async ({ raw }) => {
			const socketPath = await server.start();
			// Auto-respond to every method except "slow", which is left pending
			// so we can resolve it ourselves later, after the malformed frame,
			// to prove it wasn't corrupted or dropped.
			server.onRequest((req) => {
				if (req.method === "slow") return undefined;
				return { id: req.id, result: {} };
			});

			client = new HerdrClient({ socketPath });
			await client.connect();

			// (d) Put a request in flight before the malformed frame arrives.
			const inFlight = client.request<{ ok: boolean }>("slow", {});
			// If an assertion below throws before we explicitly settle/await
			// this promise, afterEach()'s client.close() will reject it (via
			// failPending()) with nothing else attached - guard against that
			// becoming an unhandled rejection independent of the test's own
			// pass/fail outcome.
			inFlight.catch(() => {});

			// A throw inside the socket "data" handler surfaces as an
			// uncaughtException, not a rejection the test's own call stack
			// would ever see (pushRaw's write happens over the wire, so the
			// parse/dispatch runs on a later tick, outside any try/catch here).
			// Capture it explicitly rather than relying on vitest to notice the
			// worker died, so a failure here is a real assertion, not a crash.
			const uncaught: unknown[] = [];
			const onUncaughtException = (err: unknown) => uncaught.push(err);
			process.on("uncaughtException", onUncaughtException);

			const parseErrors: string[] = [];
			client.on("parseError", (line: string) => parseErrors.push(line));

			const events: unknown[] = [];
			client.on("event", (ev) => events.push(ev));

			try {
				server.pushRaw(raw);
				await new Promise((r) => setTimeout(r, 20));

				// (a) no throw / no uncaught exception.
				expect(uncaught).toEqual([]);

				// The malformed frame was reported through the existing
				// parseError signal and never turned into an "event".
				expect(parseErrors).toEqual([raw]);
				expect(events).toEqual([]);

				// (b) the connection is still alive.
				expect(client.connected).toBe(true);

				// (c) a well-formed frame sent AFTER the malformed one is still
				// processed correctly - proves the stream/parser did not die.
				server.push({ type: "pane.created", pane_id: "w1-9" });
				await new Promise((r) => setTimeout(r, 20));
				expect(events).toEqual([{ type: "pane.created", pane_id: "w1-9" }]);

				// (d) the in-flight request from before the malformed frame is
				// still tracked correctly and resolves once its real response
				// arrives - proves `pending` wasn't corrupted or wrongly settled.
				server.pushRaw(JSON.stringify({ id: "sd-0", result: { ok: true } }));
				await expect(inFlight).resolves.toEqual({ ok: true });
			} finally {
				process.off("uncaughtException", onUncaughtException);
			}
		},
	);
});
