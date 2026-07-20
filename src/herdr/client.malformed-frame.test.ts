import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "./client.js";
import { FakeHerdrServer } from "./fake-server.js";

// Table-driven coverage for every JSON scalar/array shape that parses
// successfully (so the existing try/catch around JSON.parse never fires)
// but is not a valid protocol frame (a non-null object). `null` is the
// specific hole this suite was written to close: `JSON.parse("null")`
// returns `null` with no throw, and a `dispatch()` that read `message.id`
// unconditionally would throw synchronously inside the socket's "data"
// handler - an uncaught exception outside of any try/catch, capable of
// taking down the whole plugin process. The other shapes (number, string,
// boolean, array) already survived that specific bug, since `.id` on any of
// those is merely `undefined`, not a throw; they're included here so the
// fix is verified as a boundary validation (any non-null-object frame is
// malformed) rather than a `=== null` special case.
//
// Scoped to the event connection only (request()'s own malformed-response
// handling is covered in client.test.ts): the event connection is the one
// that can receive an arbitrary, unsolicited malformed frame at any time
// over its lifetime, which is the scenario this boundary exists for.
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
		"discards a $name frame without throwing, keeps the connection alive, and still processes later frames",
		async ({ raw }) => {
			const socketPath = await server.start();
			server.onRequest((req) => ({ id: req.id, result: { type: "subscription_started" } }));

			const uncaught: unknown[] = [];
			const onUncaughtException = (err: unknown) => uncaught.push(err);
			process.on("uncaughtException", onUncaughtException);

			try {
				client = new HerdrClient({ socketPath });
				await client.subscribe([{ type: "pane.created" }]);

				const parseErrors: string[] = [];
				client.on("parseError", (line: string) => parseErrors.push(line));

				const events: unknown[] = [];
				client.on("event", (ev) => events.push(ev));

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
				server.push({ event: "pane_created", data: { pane: { pane_id: "w1-9" } } });
				await new Promise((r) => setTimeout(r, 20));
				expect(events).toEqual([{ event: "pane_created", data: { pane: { pane_id: "w1-9" } } }]);
			} finally {
				process.off("uncaughtException", onUncaughtException);
			}
		},
	);
});
