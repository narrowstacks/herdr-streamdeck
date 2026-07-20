import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "./client.js";
import { FakeHerdrServer } from "./fake-server.js";

// Defect 2: connect() had no guard against being called twice on one instance.
// The first socket's listeners stayed attached alongside the second socket's,
// so a single pushed message got processed twice and the two sockets shared
// one `buffer`, risking corrupt splices under interleaved chunks.
describe("HerdrClient double connect", () => {
	let server: FakeHerdrServer;
	let client: HerdrClient;

	beforeEach(() => {
		server = new FakeHerdrServer();
	});

	afterEach(async () => {
		client?.close();
		await server.stop();
	});

	it("does not process a single pushed message twice after connect() is called twice", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: {} }));

		client = new HerdrClient({ socketPath });
		await client.connect();
		await client.connect(); // second call on the same instance

		const received: unknown[] = [];
		client.on("event", (ev) => received.push(ev));

		server.push({ type: "pane.created", pane_id: "w1-x" });
		await new Promise((r) => setTimeout(r, 50));

		expect(received).toEqual([{ type: "pane.created", pane_id: "w1-x" }]);
	});

	it("destroys the prior socket so the server is left with exactly one live connection", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: {} }));

		client = new HerdrClient({ socketPath });
		await client.connect();
		await client.connect();

		await new Promise((r) => setTimeout(r, 50));

		expect(server.socketCount).toBe(1);
	});

	// Finding 2 (Important): the sequential-await tests above cannot reach the
	// window where two connect() calls are both in flight at once, because
	// detachSocket() can only detach `this.socket`, which stays undefined
	// until the *first* call's onConnect fires. Two overlapping, non-awaited
	// connect() calls therefore each create their own socket, both connect,
	// and a single pushed message is delivered to the "event" listener twice.
	it("does not create two live sockets when connect() is called twice concurrently without awaiting", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: {} }));

		client = new HerdrClient({ socketPath });

		// Neither call is awaited before the next starts: this is the
		// concurrent window the sequential-await tests above cannot reach.
		const first = client.connect().catch(() => {
			/* expected to be superseded by the second call */
		});
		const second = client.connect();

		await second;
		await first;
		await new Promise((r) => setTimeout(r, 50));

		expect(server.socketCount).toBe(1);

		const received: unknown[] = [];
		client.on("event", (ev) => received.push(ev));

		server.push({ type: "pane.created", pane_id: "w1-y" });
		await new Promise((r) => setTimeout(r, 50));

		expect(received).toEqual([{ type: "pane.created", pane_id: "w1-y" }]);
	});

	// Important finding: supersede-and-reject fixed the duplicate-socket bug
	// above, but it did so by rejecting the *first* caller's connect()
	// promise. Realistic defensive init code
	// (`client.connect(); await client.connect();`) never awaits or catches
	// that first promise, so under plain `node` with default
	// --unhandled-rejections=throw, the superseded rejection crashes the
	// whole process - worse than the bug it replaced, since a crash blanks
	// every Stream Deck key instead of leaving one stale. Deliberately no
	// `.catch()` is attached to the first call here: that's exactly what
	// masked the bug in the test above.
	it("does not produce an unhandled rejection when a non-awaited connect() is followed by a second connect()", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: {} }));

		client = new HerdrClient({ socketPath });

		const unhandled: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);

		try {
			client.connect(); // deliberately not awaited, not caught
			await client.connect();

			// Give any stray rejection a chance to surface as an
			// unhandledRejection event before we assert.
			await new Promise((r) => setTimeout(r, 100));
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}

		expect(unhandled).toEqual([]);
	});
});
