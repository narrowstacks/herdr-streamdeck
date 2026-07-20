# Stream Deck Agent Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Stream Deck plugin that surfaces herdr agent state on physical keys, so a blocked agent CLI gets noticed immediately, and can be focused and approved/denied from the deck.

**Architecture:** One persistent Unix-socket connection to the running herdr server. `HerdrClient` owns framing and reconnect; `AgentRegistry` maintains agent state via a hybrid of pushed `pane.agent_status_changed` events and a periodic `agent.list` reconcile; `SlotAllocator` keeps keys stickily bound to a project cwd; three Stream Deck actions render that state and act on it.

**Tech Stack:** TypeScript 5.x, `@elgato/streamdeck` 2.1.0, Rollup + `@rollup/plugin-typescript`, Vitest. No runtime dependencies beyond the Stream Deck SDK — the herdr protocol is spoken directly over `node:net`.

**Spec:** `docs/superpowers/specs/2026-07-19-streamdeck-agent-alerts-design.md`

## Global Constraints

These apply to every task.

- **Plugin UUID:** `com.aaronfa.herdr-agents`. The plugin directory is `com.aaronfa.herdr-agents.sdPlugin`.
- **Node version in manifest:** `"Nodejs": { "Version": "20" }`. The schema declares this as `const: "20"` — no other value validates. Stream Deck supplies its own Node 20 runtime; the local Node 22 is only used for building and testing.
- **Decorators are TC39 standard decorators, not legacy.** `@elgato/streamdeck` 2.1.0 types the `action` decorator with `ClassDecoratorContext`. Therefore: `"experimentalDecorators"` must be **absent or false** in `tsconfig.json`, and the bundler must be Rollup with `@rollup/plugin-typescript` (which delegates to `tsc`). **esbuild cannot compile this project** — it does not support standard decorators.
- **ESM only.** `@elgato/streamdeck` is `"type": "module"`. `package.json` must set `"type": "module"`.
- **Manifest `Version` format** is four-part `{major}.{minor}.{patch}.{build}`, e.g. `0.1.0.0`. Three-part versions fail schema validation.
- **Each manifest action requires** `Icon`, `Name`, `States`, `UUID`.
- **herdr socket path:** `~/.config/herdr/herdr.sock`. Never hardcode `/Users/aaron` — resolve via `os.homedir()`.
- **Never render stale state as live state.** When the socket is down, keys render the `disconnected` state. This is a correctness requirement, not a polish item: a key showing a stale green while an agent sits blocked is the exact failure this plugin exists to prevent.
- **Approve/Deny must be gated on `blocked`.** Sending keys to a non-blocked agent injects stray input into a working session.
- **Verified protocol facts** (against herdr 0.6.9, protocol 13) are in the spec's "herdr socket protocol" section. Do not re-derive them; do resolve the three items in "Open items for implementation" (Task 11).

---

### Task 1: Project scaffold, build pipeline, and test harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `rollup.config.js`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/plugin.ts`
- Create: `com.aaronfa.herdr-agents.sdPlugin/manifest.json`
- Create: `src/lib/version.ts`
- Test: `src/lib/version.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a working `npm run build` that emits `com.aaronfa.herdr-agents.sdPlugin/bin/plugin.js`, and `npm test` running Vitest. `PLUGIN_UUID: string` exported from `src/lib/version.ts`.

This task exists as its own gate because a reviewer can meaningfully reject "the toolchain doesn't build" independently of any feature.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "streamdeck-herdr-agents",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "build": "rollup -c",
    "watch": "rollup -c -w",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": {
    "node": ">=20.5.1"
  },
  "dependencies": {
    "@elgato/streamdeck": "^2.1.0"
  },
  "devDependencies": {
    "@rollup/plugin-node-resolve": "^15.2.3",
    "@rollup/plugin-typescript": "^11.1.6",
    "@types/node": "^22.0.0",
    "rollup": "^4.18.0",
    "tslib": "^2.6.3",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Note the absence of `experimentalDecorators` — see Global Constraints.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "outDir": "com.aaronfa.herdr-agents.sdPlugin/bin",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 3: Create `rollup.config.js`**

```js
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

const sdPlugin = "com.aaronfa.herdr-agents.sdPlugin";

export default {
	input: "src/plugin.ts",
	output: {
		file: `${sdPlugin}/bin/plugin.js`,
		format: "es",
		sourcemap: true,
	},
	plugins: [typescript({ tsconfig: "./tsconfig.json" }), nodeResolve({ preferBuiltins: true })],
	external: ["node:net", "node:os", "node:path", "node:events", "node:fs"],
};
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
	},
});
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules/
com.aaronfa.herdr-agents.sdPlugin/bin/
*.log
```

- [ ] **Step 6: Write the failing test**

Create `src/lib/version.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PLUGIN_UUID } from "./version.js";

describe("PLUGIN_UUID", () => {
	it("matches the plugin directory name", () => {
		expect(PLUGIN_UUID).toBe("com.aaronfa.herdr-agents");
	});
});
```

- [ ] **Step 7: Install dependencies and run the test to verify it fails**

```bash
npm install
npx vitest run src/lib/version.test.ts
```

Expected: FAIL — `Failed to resolve import "./version.js"`. The module does not exist yet.

- [ ] **Step 8: Write minimal implementation**

Create `src/lib/version.ts`:

```ts
export const PLUGIN_UUID = "com.aaronfa.herdr-agents";
```

- [ ] **Step 9: Run the test to verify it passes**

```bash
npx vitest run src/lib/version.test.ts
```

Expected: PASS, 1 test.

- [ ] **Step 10: Create the manifest**

Create `com.aaronfa.herdr-agents.sdPlugin/manifest.json`. Actions are added in Task 11; this is the minimum that loads.

```json
{
	"$schema": "https://schemas.elgato.com/streamdeck/plugins/manifest.json",
	"UUID": "com.aaronfa.herdr-agents",
	"Name": "Herdr Agents",
	"Version": "0.1.0.0",
	"Author": "aaron f.a",
	"Description": "Surfaces herdr agent state on your Stream Deck and alerts when an agent needs attention.",
	"Icon": "imgs/plugin",
	"CodePath": "bin/plugin.js",
	"SDKVersion": 2,
	"Nodejs": {
		"Version": "20",
		"Debug": "enabled"
	},
	"Software": {
		"MinimumVersion": "6.5"
	},
	"OS": [
		{
			"Platform": "mac",
			"MinimumVersion": "10.15"
		}
	],
	"Actions": []
}
```

- [ ] **Step 11: Create the plugin entrypoint**

Create `src/plugin.ts`:

```ts
import streamDeck from "@elgato/streamdeck";

streamDeck.connect();
```

- [ ] **Step 12: Verify the build succeeds**

```bash
npm run build
ls -l com.aaronfa.herdr-agents.sdPlugin/bin/plugin.js
```

Expected: rollup completes with no errors and `plugin.js` exists.

- [ ] **Step 13: Commit**

```bash
git add package.json package-lock.json tsconfig.json rollup.config.js vitest.config.ts .gitignore src com.aaronfa.herdr-agents.sdPlugin
git commit -m "chore: scaffold Stream Deck plugin build and test harness"
```

---

### Task 2: HerdrClient — framing and request/response correlation

**Files:**
- Create: `src/herdr/types.ts`
- Create: `src/herdr/client.ts`
- Create: `src/herdr/fake-server.ts`
- Test: `src/herdr/client.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `type AgentStatus = "idle" | "working" | "blocked" | "unknown"`
  - `interface AgentInfo { paneId: string; agent: string; status: AgentStatus; cwd: string; focused: boolean; workspaceId: string }`
  - `class HerdrClient extends EventEmitter` with `constructor(opts: HerdrClientOptions)`, `connect(): Promise<void>`, `request<T>(method: string, params: Record<string, unknown>): Promise<T>`, `close(): void`, `get connected(): boolean`
  - `interface HerdrClientOptions { socketPath: string; reconnectBaseMs?: number; reconnectMaxMs?: number }`
  - `class FakeHerdrServer` (test helper) with `start(): Promise<string>`, `stop(): Promise<void>`, `onRequest(handler)`, `push(event: unknown): void`, `dropConnections(): void`

`fake-server.ts` is a test helper but lives in `src/` because Tasks 3, 4, and 7 all import it. It is excluded from the production bundle by virtue of never being imported by `plugin.ts`.

The wire protocol is newline-delimited JSON. Requests are `{id, method, params}`; responses echo `id` with either `result` or `error`.

- [ ] **Step 1: Write the failing test**

Create `src/herdr/client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "./client.js";
import { FakeHerdrServer } from "./fake-server.js";

describe("HerdrClient", () => {
	let server: FakeHerdrServer;
	let client: HerdrClient;

	beforeEach(async () => {
		server = new FakeHerdrServer();
	});

	afterEach(async () => {
		client?.close();
		await server.stop();
	});

	it("resolves a request with the result matching its id", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { agents: [] } }));

		client = new HerdrClient({ socketPath });
		await client.connect();

		const result = await client.request<{ agents: unknown[] }>("agent.list", {});

		expect(result).toEqual({ agents: [] });
	});

	it("rejects a request when herdr returns an error", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({
			id: req.id,
			error: { code: "pane_not_found", message: "pane nonexistent not found" },
		}));

		client = new HerdrClient({ socketPath });
		await client.connect();

		await expect(client.request("agent.focus", { target: "nope" })).rejects.toThrow(
			"pane nonexistent not found",
		);
	});

	it("correlates concurrent requests to the correct callers", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: { echoed: req.method } }));

		client = new HerdrClient({ socketPath });
		await client.connect();

		const [a, b] = await Promise.all([
			client.request<{ echoed: string }>("agent.list", {}),
			client.request<{ echoed: string }>("pane.list", {}),
		]);

		expect(a.echoed).toBe("agent.list");
		expect(b.echoed).toBe("pane.list");
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/herdr/client.test.ts
```

Expected: FAIL — cannot resolve `./client.js` and `./fake-server.js`.

- [ ] **Step 3: Write the types**

Create `src/herdr/types.ts`:

```ts
export type AgentStatus = "idle" | "working" | "blocked" | "unknown";

export interface AgentInfo {
	paneId: string;
	agent: string;
	status: AgentStatus;
	cwd: string;
	focused: boolean;
	workspaceId: string;
}

export interface HerdrRequest {
	id: string;
	method: string;
	params: Record<string, unknown>;
}

export interface HerdrResponse {
	id?: string;
	result?: unknown;
	error?: { code: string; message: string };
	type?: string;
}
```

- [ ] **Step 4: Write the fake server**

Create `src/herdr/fake-server.ts`:

```ts
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { HerdrRequest } from "./types.js";

type RequestHandler = (req: HerdrRequest) => unknown | undefined;

let counter = 0;

export class FakeHerdrServer {
	private server?: net.Server;
	private sockets = new Set<net.Socket>();
	private handler: RequestHandler = () => undefined;
	private socketPath = "";

	async start(): Promise<string> {
		this.socketPath = path.join(os.tmpdir(), `fake-herdr-${process.pid}-${counter++}.sock`);
		if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);

		this.server = net.createServer((socket) => {
			this.sockets.add(socket);
			socket.on("close", () => this.sockets.delete(socket));
			socket.on("error", () => {});

			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf8");
				let index: number;
				while ((index = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, index);
					buffer = buffer.slice(index + 1);
					if (!line.trim()) continue;
					const req = JSON.parse(line) as HerdrRequest;
					const response = this.handler(req);
					if (response !== undefined) {
						socket.write(JSON.stringify(response) + "\n");
					}
				}
			});
		});

		await new Promise<void>((resolve) => this.server!.listen(this.socketPath, resolve));
		return this.socketPath;
	}

	onRequest(handler: RequestHandler): void {
		this.handler = handler;
	}

	push(event: unknown): void {
		const line = JSON.stringify(event) + "\n";
		for (const socket of this.sockets) socket.write(line);
	}

	dropConnections(): void {
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
	}

	async stop(): Promise<void> {
		this.dropConnections();
		if (this.server) {
			await new Promise<void>((resolve) => this.server!.close(() => resolve()));
			this.server = undefined;
		}
		if (this.socketPath && fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
	}
}
```

- [ ] **Step 5: Write the minimal client**

Create `src/herdr/client.ts`. Reconnect is added in Task 4; this version connects once.

```ts
import { EventEmitter } from "node:events";
import net from "node:net";
import type { HerdrResponse } from "./types.js";

export interface HerdrClientOptions {
	socketPath: string;
	reconnectBaseMs?: number;
	reconnectMaxMs?: number;
}

interface Pending {
	resolve: (value: never) => void;
	reject: (reason: Error) => void;
}

export class HerdrClient extends EventEmitter {
	private socket?: net.Socket;
	private buffer = "";
	private pending = new Map<string, Pending>();
	private nextId = 0;
	private isConnected = false;

	constructor(private readonly options: HerdrClientOptions) {
		super();
	}

	get connected(): boolean {
		return this.isConnected;
	}

	async connect(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const socket = net.createConnection(this.options.socketPath);
			socket.setEncoding("utf8");

			const onError = (err: Error) => {
				socket.removeListener("connect", onConnect);
				reject(err);
			};
			const onConnect = () => {
				socket.removeListener("error", onError);
				this.socket = socket;
				this.isConnected = true;
				socket.on("data", (chunk: string) => this.onData(chunk));
				socket.on("error", () => {});
				this.emit("connected");
				resolve();
			};

			socket.once("error", onError);
			socket.once("connect", onConnect);
		});
	}

	request<T>(method: string, params: Record<string, unknown>): Promise<T> {
		if (!this.socket || !this.isConnected) {
			return Promise.reject(new Error("herdr client is not connected"));
		}
		const id = `sd-${this.nextId++}`;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: never) => void, reject });
			this.socket!.write(JSON.stringify({ id, method, params }) + "\n");
		});
	}

	close(): void {
		this.isConnected = false;
		this.socket?.destroy();
		this.socket = undefined;
		for (const { reject } of this.pending.values()) {
			reject(new Error("herdr client closed"));
		}
		this.pending.clear();
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let index: number;
		while ((index = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (!line.trim()) continue;

			let message: HerdrResponse;
			try {
				message = JSON.parse(line) as HerdrResponse;
			} catch {
				this.emit("parseError", line);
				continue;
			}
			this.dispatch(message);
		}
	}

	private dispatch(message: HerdrResponse): void {
		const waiter = message.id ? this.pending.get(message.id) : undefined;
		if (waiter) {
			this.pending.delete(message.id!);
			if (message.error) {
				waiter.reject(new Error(message.error.message));
			} else {
				waiter.resolve(message.result as never);
			}
			return;
		}
		this.emit("event", message);
	}
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run src/herdr/client.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add src/herdr
git commit -m "feat: add HerdrClient with newline-JSON framing and request correlation"
```

---

### Task 3: HerdrClient — event demux and subscriptions

**Files:**
- Modify: `src/herdr/client.ts` (add `subscribe`)
- Test: `src/herdr/client.events.test.ts`

**Interfaces:**
- Consumes: `HerdrClient`, `FakeHerdrServer` from Task 2.
- Produces:
  - `interface HerdrSubscription { type: string; pane_id?: string }`
  - `HerdrClient.subscribe(subscriptions: HerdrSubscription[]): Promise<void>`
  - `HerdrClient` emits `"event"` with the raw unsolicited message for anything not matching a pending request id.

Recall the verified constraint from the spec: `pane.agent_status_changed` requires `pane_id`; `pane.created` and `pane.closed` do not.

- [ ] **Step 1: Write the failing test**

Create `src/herdr/client.events.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "./client.js";
import { FakeHerdrServer } from "./fake-server.js";
import type { HerdrRequest } from "./types.js";

describe("HerdrClient events", () => {
	let server: FakeHerdrServer;
	let client: HerdrClient;

	beforeEach(() => {
		server = new FakeHerdrServer();
	});

	afterEach(async () => {
		client?.close();
		await server.stop();
	});

	it("sends subscriptions in the params shape herdr requires", async () => {
		const socketPath = await server.start();
		const seen: HerdrRequest[] = [];
		server.onRequest((req) => {
			seen.push(req);
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		await client.subscribe([
			{ type: "pane.agent_status_changed", pane_id: "w1-1" },
			{ type: "pane.created" },
		]);

		expect(seen[0].method).toBe("events.subscribe");
		expect(seen[0].params).toEqual({
			subscriptions: [
				{ type: "pane.agent_status_changed", pane_id: "w1-1" },
				{ type: "pane.created" },
			],
		});
	});

	it("emits unsolicited messages as events rather than resolving requests", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: {} }));

		client = new HerdrClient({ socketPath });
		await client.connect();

		const received: unknown[] = [];
		client.on("event", (ev) => received.push(ev));

		server.push({ type: "pane.agent_status_changed", pane_id: "w1-1", status: "blocked" });
		await new Promise((r) => setTimeout(r, 20));

		expect(received).toEqual([
			{ type: "pane.agent_status_changed", pane_id: "w1-1", status: "blocked" },
		]);
	});

	it("discards a malformed frame and keeps processing later frames", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: {} }));

		client = new HerdrClient({ socketPath });
		await client.connect();

		const received: unknown[] = [];
		client.on("event", (ev) => received.push(ev));

		server.push("this is not json" as unknown);
		server.push({ type: "pane.created", pane_id: "w1-2" });
		await new Promise((r) => setTimeout(r, 20));

		expect(received).toEqual([{ type: "pane.created", pane_id: "w1-2" }]);
	});
});
```

Note: `server.push("this is not json")` writes `"this is not json"` — a JSON string, which parses successfully. Change the fake server call to write raw bytes instead. Add this method to `src/herdr/fake-server.ts`:

```ts
	pushRaw(line: string): void {
		for (const socket of this.sockets) socket.write(line + "\n");
	}
```

and use `server.pushRaw("this is not json")` in the third test.

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/herdr/client.events.test.ts
```

Expected: FAIL — `client.subscribe is not a function`.

- [ ] **Step 3: Add `subscribe` to the client**

Add to `src/herdr/types.ts`:

```ts
export interface HerdrSubscription {
	type: string;
	pane_id?: string;
}
```

Add to `HerdrClient` in `src/herdr/client.ts` (import `HerdrSubscription` from `./types.js`):

```ts
	async subscribe(subscriptions: HerdrSubscription[]): Promise<void> {
		if (subscriptions.length === 0) return;
		await this.request("events.subscribe", { subscriptions });
	}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/herdr/
```

Expected: PASS, 6 tests total across both client test files.

- [ ] **Step 5: Commit**

```bash
git add src/herdr
git commit -m "feat: add event subscription and demux to HerdrClient"
```

---

### Task 4: HerdrClient — reconnect, backoff, and disconnect signalling

**Files:**
- Modify: `src/herdr/client.ts`
- Test: `src/herdr/client.reconnect.test.ts`

**Interfaces:**
- Consumes: `HerdrClient`, `FakeHerdrServer`.
- Produces: `HerdrClient` emits `"connected"` and `"disconnected"`. `connect()` starts a supervised connection that retries with exponential backoff between `reconnectBaseMs` (default 250) and `reconnectMaxMs` (default 5000). Pending requests reject on disconnect.

This is what makes the "never render stale state" constraint achievable: consumers learn the moment the socket dies.

- [ ] **Step 1: Write the failing test**

Create `src/herdr/client.reconnect.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "./client.js";
import { FakeHerdrServer } from "./fake-server.js";

describe("HerdrClient reconnect", () => {
	let server: FakeHerdrServer;
	let client: HerdrClient;

	beforeEach(() => {
		server = new FakeHerdrServer();
	});

	afterEach(async () => {
		client?.close();
		await server.stop();
	});

	it("emits disconnected and reports not connected when the socket drops", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: {} }));

		client = new HerdrClient({ socketPath, reconnectBaseMs: 20, reconnectMaxMs: 40 });
		await client.connect();

		const disconnected = new Promise<void>((resolve) => client.once("disconnected", resolve));
		server.dropConnections();
		await disconnected;

		expect(client.connected).toBe(false);
	});

	it("rejects in-flight requests when the socket drops", async () => {
		const socketPath = await server.start();
		server.onRequest(() => undefined); // never respond

		client = new HerdrClient({ socketPath, reconnectBaseMs: 20, reconnectMaxMs: 40 });
		await client.connect();

		const inFlight = client.request("agent.list", {});
		server.dropConnections();

		await expect(inFlight).rejects.toThrow(/disconnected/i);
	});

	it("reconnects automatically and emits connected again", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => ({ id: req.id, result: {} }));

		client = new HerdrClient({ socketPath, reconnectBaseMs: 20, reconnectMaxMs: 40 });
		await client.connect();

		let connectCount = 0;
		client.on("connected", () => connectCount++);

		server.dropConnections();
		await new Promise((r) => setTimeout(r, 200));

		expect(connectCount).toBeGreaterThanOrEqual(1);
		expect(client.connected).toBe(true);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/herdr/client.reconnect.test.ts
```

Expected: FAIL — no `disconnected` event is emitted, so the first test times out.

- [ ] **Step 3: Rewrite the client's connection management**

Replace `connect`, `close`, and add the private members in `src/herdr/client.ts`:

```ts
	private closed = false;
	private attempt = 0;
	private reconnectTimer?: NodeJS.Timeout;

	async connect(): Promise<void> {
		this.closed = false;
		await this.openOnce();
	}

	private openOnce(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const socket = net.createConnection(this.options.socketPath);
			socket.setEncoding("utf8");

			const onError = (err: Error) => {
				socket.removeListener("connect", onConnect);
				this.scheduleReconnect();
				reject(err);
			};
			const onConnect = () => {
				socket.removeListener("error", onError);
				this.socket = socket;
				this.isConnected = true;
				this.attempt = 0;
				this.buffer = "";
				socket.on("data", (chunk: string) => this.onData(chunk));
				socket.on("error", () => {});
				socket.on("close", () => this.handleDrop());
				this.emit("connected");
				resolve();
			};

			socket.once("error", onError);
			socket.once("connect", onConnect);
		});
	}

	private handleDrop(): void {
		if (!this.isConnected) return;
		this.isConnected = false;
		this.socket = undefined;
		this.failPending(new Error("herdr socket disconnected"));
		this.emit("disconnected");
		this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.closed || this.reconnectTimer) return;
		const base = this.options.reconnectBaseMs ?? 250;
		const max = this.options.reconnectMaxMs ?? 5000;
		const delay = Math.min(base * 2 ** this.attempt++, max);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			if (this.closed) return;
			this.openOnce().catch(() => {
				/* scheduleReconnect already queued by openOnce's error path */
			});
		}, delay);
	}

	private failPending(error: Error): void {
		for (const { reject } of this.pending.values()) reject(error);
		this.pending.clear();
	}

	close(): void {
		this.closed = true;
		this.isConnected = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		const socket = this.socket;
		this.socket = undefined;
		socket?.destroy();
		this.failPending(new Error("herdr client closed"));
	}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/herdr/
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/herdr
git commit -m "feat: add supervised reconnect and disconnect signalling to HerdrClient"
```

---

### Task 5: SlotAllocator — sticky cwd-to-slot assignment

**Files:**
- Create: `src/slots/allocator.ts`
- Test: `src/slots/allocator.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface SlotAllocatorState { assignments: Record<string, number> }` — cwd → slotIndex
  - `class SlotAllocator` with:
    - `constructor(state?: SlotAllocatorState)`
    - `registerSlot(slotIndex: number): void`
    - `unregisterSlot(slotIndex: number): void`
    - `claim(cwd: string): number | undefined`
    - `slotForCwd(cwd: string): number | undefined`
    - `cwdForSlot(slotIndex: number): string | undefined`
    - `toJSON(): SlotAllocatorState`

Pure logic, no I/O, no timers. `registerSlot` is called when an `AgentSlot` key appears on the deck; a slot must be registered before it can be claimed. `claim` is idempotent — claiming an already-assigned cwd returns its existing slot. Assignments are never dropped when an agent exits; that is what makes a slot "reserved".

- [ ] **Step 1: Write the failing test**

Create `src/slots/allocator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SlotAllocator } from "./allocator.js";

describe("SlotAllocator", () => {
	it("assigns the lowest registered free slot to a new cwd", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(2);
		allocator.registerSlot(0);
		allocator.registerSlot(1);

		expect(allocator.claim("/work/dorkroom")).toBe(0);
		expect(allocator.claim("/work/negpy")).toBe(1);
		expect(allocator.claim("/work/hmpc")).toBe(2);
	});

	it("returns the same slot when the same cwd is claimed again", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.registerSlot(1);

		expect(allocator.claim("/work/dorkroom")).toBe(0);
		expect(allocator.claim("/work/dorkroom")).toBe(0);
	});

	it("keeps a slot reserved for a cwd whose agent has exited", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.registerSlot(1);
		allocator.claim("/work/dorkroom");
		allocator.claim("/work/negpy");

		// negpy's agent exits — nothing is released. A new project must not take slot 1.
		expect(allocator.claim("/work/stenobar")).toBeUndefined();
		expect(allocator.cwdForSlot(1)).toBe("/work/negpy");
	});

	it("returns the original slot when a cwd reappears after its agent exited", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.registerSlot(1);
		allocator.claim("/work/dorkroom");
		allocator.claim("/work/negpy");

		expect(allocator.claim("/work/negpy")).toBe(1);
	});

	it("returns undefined when every registered slot is taken", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.claim("/work/dorkroom");

		expect(allocator.claim("/work/negpy")).toBeUndefined();
	});

	it("cannot claim a slot that is not registered", () => {
		const allocator = new SlotAllocator();

		expect(allocator.claim("/work/dorkroom")).toBeUndefined();
	});

	it("round-trips assignments through toJSON and the constructor", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.registerSlot(1);
		allocator.claim("/work/dorkroom");
		allocator.claim("/work/negpy");

		const restored = new SlotAllocator(allocator.toJSON());
		restored.registerSlot(0);
		restored.registerSlot(1);

		expect(restored.slotForCwd("/work/negpy")).toBe(1);
		expect(restored.cwdForSlot(0)).toBe("/work/dorkroom");
	});

	it("keeps assignments for slots that are no longer registered", () => {
		const allocator = new SlotAllocator();
		allocator.registerSlot(0);
		allocator.claim("/work/dorkroom");
		allocator.unregisterSlot(0);

		expect(allocator.slotForCwd("/work/dorkroom")).toBe(0);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/slots/allocator.test.ts
```

Expected: FAIL — cannot resolve `./allocator.js`.

- [ ] **Step 3: Write the implementation**

Create `src/slots/allocator.ts`:

```ts
export interface SlotAllocatorState {
	assignments: Record<string, number>;
}

export class SlotAllocator {
	private readonly assignments: Map<string, number>;
	private readonly registered = new Set<number>();

	constructor(state?: SlotAllocatorState) {
		this.assignments = new Map(Object.entries(state?.assignments ?? {}));
	}

	registerSlot(slotIndex: number): void {
		this.registered.add(slotIndex);
	}

	unregisterSlot(slotIndex: number): void {
		this.registered.delete(slotIndex);
	}

	claim(cwd: string): number | undefined {
		const existing = this.assignments.get(cwd);
		if (existing !== undefined) return existing;

		const taken = new Set(this.assignments.values());
		const free = [...this.registered].filter((i) => !taken.has(i)).sort((a, b) => a - b);
		const slot = free[0];
		if (slot === undefined) return undefined;

		this.assignments.set(cwd, slot);
		return slot;
	}

	slotForCwd(cwd: string): number | undefined {
		return this.assignments.get(cwd);
	}

	cwdForSlot(slotIndex: number): string | undefined {
		for (const [cwd, index] of this.assignments) {
			if (index === slotIndex) return cwd;
		}
		return undefined;
	}

	toJSON(): SlotAllocatorState {
		return { assignments: Object.fromEntries(this.assignments) };
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/slots/allocator.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/slots
git commit -m "feat: add sticky cwd-to-slot allocator"
```

---

### Task 6: AgentRegistry — seeding and reconcile

**Files:**
- Create: `src/agents/registry.ts`
- Test: `src/agents/registry.test.ts`

**Interfaces:**
- Consumes: `HerdrClient`, `FakeHerdrServer`, `AgentInfo`, `AgentStatus`.
- Produces:
  - `interface AgentRegistryOptions { reconcileIntervalMs?: number }`
  - `class AgentRegistry extends EventEmitter` with:
    - `constructor(client: HerdrClient, options?: AgentRegistryOptions)`
    - `start(): Promise<void>`
    - `stop(): void`
    - `get agents(): AgentInfo[]`
    - `getByPaneId(paneId: string): AgentInfo | undefined`
    - `getByCwd(cwd: string): AgentInfo | undefined`
    - `get focused(): AgentInfo | undefined`
    - `get connected(): boolean`
  - Emits `"changed"` whenever the agent set or any agent's status changes, and whenever connectivity changes.

`agent.list` returns raw snake_case fields; the registry normalizes them to `AgentInfo`. The verified raw shape is in the spec.

- [ ] **Step 1: Write the failing test**

Create `src/agents/registry.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "../herdr/client.js";
import { FakeHerdrServer } from "../herdr/fake-server.js";
import { AgentRegistry } from "./registry.js";

function agentListResult(agents: Array<Record<string, unknown>>) {
	return { agents, type: "agent_list" };
}

const CLAUDE = {
	agent: "claude",
	agent_status: "working",
	cwd: "/work/dorkroom",
	focused: true,
	pane_id: "w1-1",
	workspace_id: "w1",
};

describe("AgentRegistry", () => {
	let server: FakeHerdrServer;
	let client: HerdrClient;
	let registry: AgentRegistry;

	beforeEach(() => {
		server = new FakeHerdrServer();
	});

	afterEach(async () => {
		registry?.stop();
		client?.close();
		await server.stop();
	});

	it("normalizes agent.list into AgentInfo", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => {
			if (req.method === "agent.list") return { id: req.id, result: agentListResult([CLAUDE]) };
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();

		expect(registry.agents).toEqual([
			{
				paneId: "w1-1",
				agent: "claude",
				status: "working",
				cwd: "/work/dorkroom",
				focused: true,
				workspaceId: "w1",
			},
		]);
	});

	it("exposes the focused agent", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => {
			if (req.method === "agent.list") {
				return {
					id: req.id,
					result: agentListResult([
						{ ...CLAUDE, focused: false },
						{ ...CLAUDE, pane_id: "w1-2", cwd: "/work/negpy", focused: true, agent: "codex" },
					]),
				};
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();

		expect(registry.focused?.agent).toBe("codex");
		expect(registry.focused?.paneId).toBe("w1-2");
	});

	it("maps an unrecognized status to unknown", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => {
			if (req.method === "agent.list") {
				return { id: req.id, result: agentListResult([{ ...CLAUDE, agent_status: "wat" }]) };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();

		expect(registry.agents[0].status).toBe("unknown");
	});

	it("picks up a status change on the reconcile tick even with no events", async () => {
		const socketPath = await server.start();
		let status = "working";
		server.onRequest((req) => {
			if (req.method === "agent.list") {
				return { id: req.id, result: agentListResult([{ ...CLAUDE, agent_status: status }]) };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 25 });
		await registry.start();
		expect(registry.agents[0].status).toBe("working");

		status = "blocked";
		await new Promise<void>((resolve) => registry.once("changed", resolve));

		expect(registry.agents[0].status).toBe("blocked");
	});

	it("reports disconnected and empties agents when the socket drops", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => {
			if (req.method === "agent.list") return { id: req.id, result: agentListResult([CLAUDE]) };
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath, reconnectBaseMs: 10_000 });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();
		expect(registry.connected).toBe(true);

		const changed = new Promise<void>((resolve) => registry.once("changed", resolve));
		server.dropConnections();
		await changed;

		expect(registry.connected).toBe(false);
		expect(registry.agents).toEqual([]);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/agents/registry.test.ts
```

Expected: FAIL — cannot resolve `./registry.js`.

- [ ] **Step 3: Write the implementation**

Create `src/agents/registry.ts`. Per-pane subscriptions come in Task 7; this version reconciles on a timer and reacts to connectivity.

```ts
import { EventEmitter } from "node:events";
import type { HerdrClient } from "../herdr/client.js";
import type { AgentInfo, AgentStatus } from "../herdr/types.js";

export interface AgentRegistryOptions {
	reconcileIntervalMs?: number;
}

interface RawAgent {
	agent?: string;
	agent_status?: string;
	cwd?: string;
	focused?: boolean;
	pane_id?: string;
	workspace_id?: string;
}

const STATUSES: AgentStatus[] = ["idle", "working", "blocked", "unknown"];

function toStatus(raw: string | undefined): AgentStatus {
	return STATUSES.includes(raw as AgentStatus) ? (raw as AgentStatus) : "unknown";
}

function toAgentInfo(raw: RawAgent): AgentInfo {
	return {
		paneId: raw.pane_id ?? "",
		agent: raw.agent ?? "unknown",
		status: toStatus(raw.agent_status),
		cwd: raw.cwd ?? "",
		focused: raw.focused === true,
		workspaceId: raw.workspace_id ?? "",
	};
}

export class AgentRegistry extends EventEmitter {
	private byPaneId = new Map<string, AgentInfo>();
	private timer?: NodeJS.Timeout;
	private stopped = false;

	constructor(
		private readonly client: HerdrClient,
		private readonly options: AgentRegistryOptions = {},
	) {
		super();
	}

	get connected(): boolean {
		return this.client.connected;
	}

	get agents(): AgentInfo[] {
		return [...this.byPaneId.values()];
	}

	getByPaneId(paneId: string): AgentInfo | undefined {
		return this.byPaneId.get(paneId);
	}

	getByCwd(cwd: string): AgentInfo | undefined {
		return this.agents.find((a) => a.cwd === cwd);
	}

	get focused(): AgentInfo | undefined {
		return this.agents.find((a) => a.focused);
	}

	async start(): Promise<void> {
		this.stopped = false;
		this.client.on("disconnected", this.onDisconnected);
		this.client.on("connected", this.onConnected);
		await this.reconcile();
		this.scheduleTick();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.client.off("disconnected", this.onDisconnected);
		this.client.off("connected", this.onConnected);
	}

	private onDisconnected = (): void => {
		this.byPaneId.clear();
		this.emit("changed");
	};

	private onConnected = (): void => {
		void this.reconcile();
	};

	private scheduleTick(): void {
		if (this.stopped) return;
		const interval = this.options.reconcileIntervalMs ?? 5000;
		this.timer = setTimeout(async () => {
			await this.reconcile();
			this.scheduleTick();
		}, interval);
	}

	protected async reconcile(): Promise<void> {
		if (!this.client.connected) return;
		let result: { agents?: RawAgent[] };
		try {
			result = await this.client.request<{ agents?: RawAgent[] }>("agent.list", {});
		} catch {
			return; // disconnect path already emits changed
		}

		const next = new Map<string, AgentInfo>();
		for (const raw of result.agents ?? []) {
			const info = toAgentInfo(raw);
			if (info.paneId) next.set(info.paneId, info);
		}

		if (this.differs(next)) {
			this.byPaneId = next;
			this.emit("changed");
		} else {
			this.byPaneId = next;
		}
	}

	private differs(next: Map<string, AgentInfo>): boolean {
		if (next.size !== this.byPaneId.size) return true;
		for (const [paneId, info] of next) {
			const prev = this.byPaneId.get(paneId);
			if (!prev) return true;
			if (
				prev.status !== info.status ||
				prev.focused !== info.focused ||
				prev.cwd !== info.cwd ||
				prev.agent !== info.agent
			) {
				return true;
			}
		}
		return false;
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/agents/registry.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/agents
git commit -m "feat: add AgentRegistry with agent.list seeding and reconcile tick"
```

---

### Task 7: AgentRegistry — per-pane subscriptions and push handling

**Files:**
- Modify: `src/agents/registry.ts`
- Test: `src/agents/registry.events.test.ts`

**Interfaces:**
- Consumes: `AgentRegistry` from Task 6.
- Produces: no new public methods. `AgentRegistry.start()` now also subscribes to `pane.created`, `pane.closed`, and `pane.agent_detected` globally, plus `pane.agent_status_changed` per discovered pane, and applies pushed status changes immediately.

Subscription bookkeeping: track which pane ids we have already subscribed to, and after each reconcile subscribe to any newly-seen panes. herdr has no unsubscribe in the verified method list, so subscriptions for dead panes are simply left to lapse; the tracking set prevents duplicate subscribes.

- [ ] **Step 1: Write the failing test**

Create `src/agents/registry.events.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HerdrClient } from "../herdr/client.js";
import { FakeHerdrServer } from "../herdr/fake-server.js";
import type { HerdrRequest } from "../herdr/types.js";
import { AgentRegistry } from "./registry.js";

const CLAUDE = {
	agent: "claude",
	agent_status: "working",
	cwd: "/work/dorkroom",
	focused: true,
	pane_id: "w1-1",
	workspace_id: "w1",
};

describe("AgentRegistry subscriptions", () => {
	let server: FakeHerdrServer;
	let client: HerdrClient;
	let registry: AgentRegistry;

	beforeEach(() => {
		server = new FakeHerdrServer();
	});

	afterEach(async () => {
		registry?.stop();
		client?.close();
		await server.stop();
	});

	it("subscribes per-pane for status changes and globally for pane lifecycle", async () => {
		const socketPath = await server.start();
		const seen: HerdrRequest[] = [];
		server.onRequest((req) => {
			seen.push(req);
			if (req.method === "agent.list") {
				return { id: req.id, result: { agents: [CLAUDE], type: "agent_list" } };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();

		const subs = seen
			.filter((r) => r.method === "events.subscribe")
			.flatMap((r) => (r.params as { subscriptions: Array<Record<string, unknown>> }).subscriptions);

		expect(subs).toContainEqual({ type: "pane.created" });
		expect(subs).toContainEqual({ type: "pane.closed" });
		expect(subs).toContainEqual({ type: "pane.agent_detected" });
		expect(subs).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w1-1" });
	});

	it("applies a pushed status change without waiting for the reconcile tick", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => {
			if (req.method === "agent.list") {
				return { id: req.id, result: { agents: [CLAUDE], type: "agent_list" } };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();
		expect(registry.agents[0].status).toBe("working");

		const changed = new Promise<void>((resolve) => registry.once("changed", resolve));
		server.push({
			type: "pane.agent_status_changed",
			pane_id: "w1-1",
			agent_status: "blocked",
		});
		await changed;

		expect(registry.getByPaneId("w1-1")?.status).toBe("blocked");
	});

	it("ignores a status event for an unknown pane", async () => {
		const socketPath = await server.start();
		server.onRequest((req) => {
			if (req.method === "agent.list") {
				return { id: req.id, result: { agents: [CLAUDE], type: "agent_list" } };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 10_000 });
		await registry.start();

		server.push({ type: "pane.agent_status_changed", pane_id: "ghost", agent_status: "blocked" });
		await new Promise((r) => setTimeout(r, 20));

		expect(registry.getByPaneId("ghost")).toBeUndefined();
		expect(registry.agents).toHaveLength(1);
	});

	it("does not subscribe twice for the same pane across reconciles", async () => {
		const socketPath = await server.start();
		const seen: HerdrRequest[] = [];
		server.onRequest((req) => {
			seen.push(req);
			if (req.method === "agent.list") {
				return { id: req.id, result: { agents: [CLAUDE], type: "agent_list" } };
			}
			return { id: req.id, result: { type: "subscription_started" } };
		});

		client = new HerdrClient({ socketPath });
		await client.connect();
		registry = new AgentRegistry(client, { reconcileIntervalMs: 15 });
		await registry.start();
		await new Promise((r) => setTimeout(r, 60));

		const paneSubs = seen
			.filter((r) => r.method === "events.subscribe")
			.flatMap((r) => (r.params as { subscriptions: Array<Record<string, unknown>> }).subscriptions)
			.filter((s) => s.type === "pane.agent_status_changed");

		expect(paneSubs).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/agents/registry.events.test.ts
```

Expected: FAIL — the first test finds no `events.subscribe` requests at all.

- [ ] **Step 3: Add subscription and push handling to the registry**

Add to `AgentRegistry` in `src/agents/registry.ts`:

```ts
	private subscribedPanes = new Set<string>();
```

Extend `start()` — insert the global subscribe and event listener before `await this.reconcile()`:

```ts
	async start(): Promise<void> {
		this.stopped = false;
		this.client.on("disconnected", this.onDisconnected);
		this.client.on("connected", this.onConnected);
		this.client.on("event", this.onEvent);

		await this.client.subscribe([
			{ type: "pane.created" },
			{ type: "pane.closed" },
			{ type: "pane.agent_detected" },
		]);

		await this.reconcile();
		this.scheduleTick();
	}
```

Extend `stop()`:

```ts
		this.client.off("event", this.onEvent);
```

Extend `onDisconnected` to clear subscription bookkeeping, since subscriptions do not survive a new connection:

```ts
	private onDisconnected = (): void => {
		this.byPaneId.clear();
		this.subscribedPanes.clear();
		this.emit("changed");
	};
```

Change `onConnected` to re-establish global subscriptions:

```ts
	private onConnected = (): void => {
		void (async () => {
			try {
				await this.client.subscribe([
					{ type: "pane.created" },
					{ type: "pane.closed" },
					{ type: "pane.agent_detected" },
				]);
			} catch {
				return;
			}
			await this.reconcile();
		})();
	};
```

Add the event handler:

```ts
	private onEvent = (event: { type?: string; pane_id?: string; agent_status?: string }): void => {
		if (event.type === "pane.created" || event.type === "pane.closed" || event.type === "pane.agent_detected") {
			void this.reconcile();
			return;
		}

		if (event.type === "pane.agent_status_changed" && event.pane_id) {
			const existing = this.byPaneId.get(event.pane_id);
			if (!existing) return;
			const status = toStatus(event.agent_status);
			if (existing.status === status) return;
			this.byPaneId.set(event.pane_id, { ...existing, status });
			this.emit("changed");
		}
	};
```

Add per-pane subscription at the end of `reconcile()`, after the `byPaneId` assignment:

```ts
		await this.subscribeNewPanes();
```

and the method:

```ts
	private async subscribeNewPanes(): Promise<void> {
		const fresh = [...this.byPaneId.keys()].filter((id) => !this.subscribedPanes.has(id));
		if (fresh.length === 0) return;
		for (const id of fresh) this.subscribedPanes.add(id);
		try {
			await this.client.subscribe(
				fresh.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
			);
		} catch {
			for (const id of fresh) this.subscribedPanes.delete(id);
		}
	}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/agents/
```

Expected: PASS, 9 tests across both registry test files.

- [ ] **Step 5: Run the whole suite to check for regressions**

```bash
npm test
```

Expected: PASS, 27 tests total.

- [ ] **Step 6: Commit**

```bash
git add src/agents
git commit -m "feat: add per-pane status subscriptions and push handling to AgentRegistry"
```

---

### Task 8: Keymap resolution

**Files:**
- Create: `src/keymap/keymap.ts`
- Create: `com.aaronfa.herdr-agents.sdPlugin/keymap.json`
- Test: `src/keymap/keymap.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface KeySequence { approve: string[]; deny: string[] }`
  - `type KeymapTable = Record<string, KeySequence>` — must contain a `"default"` entry
  - `const DEFAULT_KEYMAP: KeymapTable`
  - `function resolveKeymap(agentLabel: string, table?: KeymapTable, override?: Partial<KeySequence>): KeySequence`

Lookup is case-insensitive on the agent label. An unknown label falls back to `default`. A per-slot `override` wins field-by-field, so a user can override only `deny`.

**The key names in `DEFAULT_KEYMAP` are unverified placeholders.** Task 11 resolves them. Ship them behind the fallback so a wrong guess degrades to `default` rather than sending garbage.

- [ ] **Step 1: Write the failing test**

Create `src/keymap/keymap.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DEFAULT_KEYMAP, resolveKeymap, type KeymapTable } from "./keymap.js";

const TABLE: KeymapTable = {
	claude: { approve: ["Enter"], deny: ["Escape"] },
	weird: { approve: ["y"], deny: ["n"] },
	default: { approve: ["Enter"], deny: ["Escape"] },
};

describe("resolveKeymap", () => {
	it("resolves a known agent label", () => {
		expect(resolveKeymap("weird", TABLE)).toEqual({ approve: ["y"], deny: ["n"] });
	});

	it("matches agent labels case-insensitively", () => {
		expect(resolveKeymap("WEIRD", TABLE)).toEqual({ approve: ["y"], deny: ["n"] });
	});

	it("falls back to default for an unknown agent", () => {
		expect(resolveKeymap("brand-new-cli", TABLE)).toEqual({
			approve: ["Enter"],
			deny: ["Escape"],
		});
	});

	it("applies a partial override without discarding the other field", () => {
		expect(resolveKeymap("weird", TABLE, { deny: ["q"] })).toEqual({
			approve: ["y"],
			deny: ["q"],
		});
	});

	it("ships a default entry in DEFAULT_KEYMAP", () => {
		expect(DEFAULT_KEYMAP.default).toBeDefined();
		expect(DEFAULT_KEYMAP.default.approve.length).toBeGreaterThan(0);
		expect(DEFAULT_KEYMAP.default.deny.length).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/keymap/keymap.test.ts
```

Expected: FAIL — cannot resolve `./keymap.js`.

- [ ] **Step 3: Write the implementation**

Create `src/keymap/keymap.ts`:

```ts
export interface KeySequence {
	approve: string[];
	deny: string[];
}

export type KeymapTable = Record<string, KeySequence>;

/**
 * UNVERIFIED PLACEHOLDERS. The key-name vocabulary accepted by herdr's
 * `pane.send_keys`, and the correct approve/deny sequence per agent CLI, are
 * both open items resolved in Task 11 of the implementation plan. Any agent not
 * listed here falls back to `default`.
 */
export const DEFAULT_KEYMAP: KeymapTable = {
	claude: { approve: ["Enter"], deny: ["Escape"] },
	codex: { approve: ["Enter"], deny: ["Escape"] },
	default: { approve: ["Enter"], deny: ["Escape"] },
};

export function resolveKeymap(
	agentLabel: string,
	table: KeymapTable = DEFAULT_KEYMAP,
	override?: Partial<KeySequence>,
): KeySequence {
	const key = agentLabel.toLowerCase();
	const base = table[key] ?? table.default;
	return {
		approve: override?.approve ?? base.approve,
		deny: override?.deny ?? base.deny,
	};
}
```

- [ ] **Step 4: Create the shipped keymap file**

Create `com.aaronfa.herdr-agents.sdPlugin/keymap.json`. This exists so a new agent CLI is a config edit rather than a rebuild; loading it is wired in Task 11.

```json
{
	"_comment": "Approve/deny key sequences per agent label as reported by herdr. Unlisted agents fall back to 'default'. Key names must match herdr's pane.send_keys vocabulary.",
	"claude": { "approve": ["Enter"], "deny": ["Escape"] },
	"codex": { "approve": ["Enter"], "deny": ["Escape"] },
	"default": { "approve": ["Enter"], "deny": ["Escape"] }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run src/keymap/keymap.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add src/keymap com.aaronfa.herdr-agents.sdPlugin/keymap.json
git commit -m "feat: add per-agent approve/deny keymap resolution"
```

---

### Task 9: Slot rendering

**Files:**
- Create: `src/slots/render.ts`
- Test: `src/slots/render.test.ts`

**Interfaces:**
- Consumes: `AgentStatus`.
- Produces:
  - `type SlotRender = { kind: "agent"; status: AgentStatus; agent: string; project: string } | { kind: "reserved"; project: string } | { kind: "unclaimed" } | { kind: "disconnected" }`
  - `function slotTitle(render: SlotRender): string`
  - `function slotImage(render: SlotRender, pulseOn: boolean): string` — an SVG data URI
  - `function projectLabel(cwd: string): string` — basename, empty string for empty input

Keys are 72×72. Rendering is a self-contained SVG data URI, so there are no image assets to ship for state.

- [ ] **Step 1: Write the failing test**

Create `src/slots/render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { projectLabel, slotImage, slotTitle } from "./render.js";

describe("projectLabel", () => {
	it("uses the basename of the cwd", () => {
		expect(projectLabel("/Users/aaron/workspace/dorkroom")).toBe("dorkroom");
	});

	it("returns an empty string for an empty cwd", () => {
		expect(projectLabel("")).toBe("");
	});
});

describe("slotTitle", () => {
	it("shows agent and project for an active agent", () => {
		expect(slotTitle({ kind: "agent", status: "blocked", agent: "claude", project: "dorkroom" })).toBe(
			"claude\ndorkroom",
		);
	});

	it("shows the project for a reserved slot", () => {
		expect(slotTitle({ kind: "reserved", project: "negpy" })).toBe("negpy");
	});

	it("shows nothing for an unclaimed slot", () => {
		expect(slotTitle({ kind: "unclaimed" })).toBe("");
	});

	it("names the disconnected state explicitly rather than looking idle", () => {
		expect(slotTitle({ kind: "disconnected" })).toBe("no herdr");
	});
});

describe("slotImage", () => {
	it("returns an svg data uri", () => {
		const image = slotImage({ kind: "unclaimed" }, false);
		expect(image.startsWith("data:image/svg+xml;base64,")).toBe(true);
	});

	it("renders blocked differently on and off the pulse", () => {
		const on = slotImage({ kind: "agent", status: "blocked", agent: "claude", project: "d" }, true);
		const off = slotImage({ kind: "agent", status: "blocked", agent: "claude", project: "d" }, false);
		expect(on).not.toBe(off);
	});

	it("does not pulse a working agent", () => {
		const on = slotImage({ kind: "agent", status: "working", agent: "claude", project: "d" }, true);
		const off = slotImage({ kind: "agent", status: "working", agent: "claude", project: "d" }, false);
		expect(on).toBe(off);
	});

	it("renders disconnected distinctly from idle", () => {
		const disconnected = slotImage({ kind: "disconnected" }, false);
		const idle = slotImage({ kind: "agent", status: "idle", agent: "claude", project: "d" }, false);
		expect(disconnected).not.toBe(idle);
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/slots/render.test.ts
```

Expected: FAIL — cannot resolve `./render.js`.

- [ ] **Step 3: Write the implementation**

Create `src/slots/render.ts`:

```ts
import type { AgentStatus } from "../herdr/types.js";

export type SlotRender =
	| { kind: "agent"; status: AgentStatus; agent: string; project: string }
	| { kind: "reserved"; project: string }
	| { kind: "unclaimed" }
	| { kind: "disconnected" };

const COLORS: Record<AgentStatus, string> = {
	blocked: "#e5484d",
	working: "#f5a524",
	idle: "#30a46c",
	unknown: "#6f6f6f",
};

const RESERVED_COLOR = "#2a2a2a";
const UNCLAIMED_COLOR = "#111111";
const DISCONNECTED_COLOR = "#3a2a2a";

export function projectLabel(cwd: string): string {
	if (!cwd) return "";
	const parts = cwd.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? "";
}

export function slotTitle(render: SlotRender): string {
	switch (render.kind) {
		case "agent":
			return `${render.agent}\n${render.project}`;
		case "reserved":
			return render.project;
		case "unclaimed":
			return "";
		case "disconnected":
			return "no herdr";
	}
}

function background(render: SlotRender, pulseOn: boolean): string {
	switch (render.kind) {
		case "agent":
			if (render.status === "blocked" && !pulseOn) return "#7a1f22";
			return COLORS[render.status];
		case "reserved":
			return RESERVED_COLOR;
		case "unclaimed":
			return UNCLAIMED_COLOR;
		case "disconnected":
			return DISCONNECTED_COLOR;
	}
}

function glyph(render: SlotRender): string {
	if (render.kind === "disconnected") {
		return `<line x1="24" y1="24" x2="48" y2="48" stroke="#e5484d" stroke-width="5" stroke-linecap="round"/>
		<line x1="48" y1="24" x2="24" y2="48" stroke="#e5484d" stroke-width="5" stroke-linecap="round"/>`;
	}
	if (render.kind === "agent" && render.status === "blocked") {
		return `<circle cx="36" cy="36" r="14" fill="none" stroke="#ffffff" stroke-width="4"/>
		<line x1="36" y1="28" x2="36" y2="38" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/>
		<circle cx="36" cy="45" r="2.5" fill="#ffffff"/>`;
	}
	return "";
}

export function slotImage(render: SlotRender, pulseOn: boolean): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
	<rect width="72" height="72" rx="8" fill="${background(render, pulseOn)}"/>
	${glyph(render)}
</svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/slots/render.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/slots
git commit -m "feat: add SVG slot rendering with distinct disconnected state"
```

---

### Task 10: Approve/Deny targeting logic

**Files:**
- Create: `src/actions/approval.ts`
- Test: `src/actions/approval.test.ts`

**Interfaces:**
- Consumes: `AgentInfo`, `KeySequence`, `KeymapTable`, `resolveKeymap`.
- Produces:
  - `type ApprovalDecision = { ok: true; paneId: string; keys: string[] } | { ok: false; reason: "disconnected" | "no-focused-agent" | "not-blocked" }`
  - `function decideApproval(input: ApprovalInput): ApprovalDecision`
  - `interface ApprovalInput { connected: boolean; focused: AgentInfo | undefined; intent: "approve" | "deny"; table?: KeymapTable; override?: Partial<KeySequence> }`

Pulling this out as a pure function is what makes the safety gate testable without a Stream Deck attached. The action classes in Task 11 become thin wrappers over it.

- [ ] **Step 1: Write the failing test**

Create `src/actions/approval.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../herdr/types.js";
import { decideApproval } from "./approval.js";

const blocked: AgentInfo = {
	paneId: "w1-1",
	agent: "claude",
	status: "blocked",
	cwd: "/work/dorkroom",
	focused: true,
	workspaceId: "w1",
};

describe("decideApproval", () => {
	it("approves a blocked focused agent with its approve keys", () => {
		const decision = decideApproval({ connected: true, focused: blocked, intent: "approve" });
		expect(decision).toEqual({ ok: true, paneId: "w1-1", keys: ["Enter"] });
	});

	it("denies a blocked focused agent with its deny keys", () => {
		const decision = decideApproval({ connected: true, focused: blocked, intent: "deny" });
		expect(decision).toEqual({ ok: true, paneId: "w1-1", keys: ["Escape"] });
	});

	it("refuses when the focused agent is working, not blocked", () => {
		const decision = decideApproval({
			connected: true,
			focused: { ...blocked, status: "working" },
			intent: "approve",
		});
		expect(decision).toEqual({ ok: false, reason: "not-blocked" });
	});

	it("refuses when the focused agent is idle", () => {
		const decision = decideApproval({
			connected: true,
			focused: { ...blocked, status: "idle" },
			intent: "approve",
		});
		expect(decision).toEqual({ ok: false, reason: "not-blocked" });
	});

	it("refuses when nothing is focused", () => {
		const decision = decideApproval({ connected: true, focused: undefined, intent: "approve" });
		expect(decision).toEqual({ ok: false, reason: "no-focused-agent" });
	});

	it("refuses when herdr is disconnected, even with a stale blocked agent", () => {
		const decision = decideApproval({ connected: false, focused: blocked, intent: "approve" });
		expect(decision).toEqual({ ok: false, reason: "disconnected" });
	});

	it("honours a per-slot override", () => {
		const decision = decideApproval({
			connected: true,
			focused: blocked,
			intent: "approve",
			override: { approve: ["y"] },
		});
		expect(decision).toEqual({ ok: true, paneId: "w1-1", keys: ["y"] });
	});

	it("falls back to the default keymap for an unknown agent label", () => {
		const decision = decideApproval({
			connected: true,
			focused: { ...blocked, agent: "brand-new-cli" },
			intent: "approve",
		});
		expect(decision).toEqual({ ok: true, paneId: "w1-1", keys: ["Enter"] });
	});
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run src/actions/approval.test.ts
```

Expected: FAIL — cannot resolve `./approval.js`.

- [ ] **Step 3: Write the implementation**

Create `src/actions/approval.ts`:

```ts
import type { AgentInfo } from "../herdr/types.js";
import { resolveKeymap, type KeymapTable, type KeySequence } from "../keymap/keymap.js";

export interface ApprovalInput {
	connected: boolean;
	focused: AgentInfo | undefined;
	intent: "approve" | "deny";
	table?: KeymapTable;
	override?: Partial<KeySequence>;
}

export type ApprovalDecision =
	| { ok: true; paneId: string; keys: string[] }
	| { ok: false; reason: "disconnected" | "no-focused-agent" | "not-blocked" };

export function decideApproval(input: ApprovalInput): ApprovalDecision {
	if (!input.connected) return { ok: false, reason: "disconnected" };
	if (!input.focused) return { ok: false, reason: "no-focused-agent" };
	if (input.focused.status !== "blocked") return { ok: false, reason: "not-blocked" };

	const sequence = resolveKeymap(input.focused.agent, input.table, input.override);
	return {
		ok: true,
		paneId: input.focused.paneId,
		keys: input.intent === "approve" ? sequence.approve : sequence.deny,
	};
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/actions/approval.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/actions
git commit -m "feat: add approve/deny decision logic with blocked-state gate"
```

---

### Task 11: Wire up Stream Deck actions and resolve open protocol items

**Files:**
- Create: `src/actions/agent-slot.ts`
- Create: `src/actions/approve.ts`
- Create: `src/actions/deny.ts`
- Create: `src/plugin-state.ts`
- Modify: `src/plugin.ts`
- Modify: `com.aaronfa.herdr-agents.sdPlugin/manifest.json`
- Create: `com.aaronfa.herdr-agents.sdPlugin/ui/agent-slot.html`
- Create: `com.aaronfa.herdr-agents.sdPlugin/imgs/plugin.png` (144×144 PNG)
- Create: `com.aaronfa.herdr-agents.sdPlugin/imgs/actions/slot.png` (144×144 PNG)
- Create: `com.aaronfa.herdr-agents.sdPlugin/imgs/actions/approve.png` (144×144 PNG)
- Create: `com.aaronfa.herdr-agents.sdPlugin/imgs/actions/deny.png` (144×144 PNG)
- Modify: `com.aaronfa.herdr-agents.sdPlugin/keymap.json` (after verification)
- Modify: `docs/superpowers/specs/2026-07-19-streamdeck-agent-alerts-design.md` (record resolved open items)

**Interfaces:**
- Consumes: everything from Tasks 2–10.
- Produces: a loadable plugin with three registered actions.

This task ends in manual verification against live herdr, because the end-to-end path needs a real agent CLI actually blocking — that cannot be faked meaningfully.

- [ ] **Step 1: Resolve open item — the `pane.send_keys` key vocabulary**

This must be settled before the keymap can be trusted. Create a scratch pane and probe it with a deliberately invalid key name to make herdr report what it accepts.

```bash
herdr agent list
```

Take a real `pane_id` from the output, then:

```bash
printf '{"id":"probe","method":"pane.send_keys","params":{"pane_id":"REAL_PANE_ID","keys":["definitely_not_a_key"]}}\n' \
  | nc -U ~/.config/herdr/herdr.sock
```

Record the accepted key names from the error message. If the error does not enumerate them, fall back to:

```bash
herdr pane send-keys --help
```

Write the verified vocabulary into a comment at the top of `src/keymap/keymap.ts`, replacing the "UNVERIFIED PLACEHOLDERS" block.

- [ ] **Step 2: Resolve open item — per-agent approve/deny sequences**

For each of `claude` and `codex`: start the CLI in a herdr pane, drive it to an approval prompt (e.g. ask Claude Code to run a shell command that requires approval), confirm `herdr agent list` reports `agent_status: "blocked"`, then send the candidate approve sequence and confirm the prompt accepts.

Update `com.aaronfa.herdr-agents.sdPlugin/keymap.json` and `DEFAULT_KEYMAP` in `src/keymap/keymap.ts` with verified values. **If an agent's sequence cannot be verified, remove its entry entirely** so it falls through to `default` — an unverified entry that looks authoritative is worse than an honest fallback.

- [ ] **Step 3: Resolve open item — the `pane.agent_status_changed` payload shape**

With a subscription open, drive an agent into and out of `blocked` and capture the raw event:

```bash
(printf '{"id":"s1","method":"events.subscribe","params":{"subscriptions":[{"type":"pane.agent_status_changed","pane_id":"REAL_PANE_ID"}]}}\n'; sleep 120) \
  | nc -U ~/.config/herdr/herdr.sock
```

Task 7's `onEvent` assumes the status arrives as `event.agent_status`. If the real field differs (e.g. `status`, or nested under `agent`), fix `onEvent` in `src/agents/registry.ts` **and** update the corresponding test in `src/agents/registry.events.test.ts` to push the real shape. Record the confirmed shape in the spec's protocol section.

- [ ] **Step 4: Write the shared plugin state module**

Create `src/plugin-state.ts`:

```ts
import os from "node:os";
import path from "node:path";
import streamDeck from "@elgato/streamdeck";
import { AgentRegistry } from "./agents/registry.js";
import { HerdrClient } from "./herdr/client.js";
import { SlotAllocator, type SlotAllocatorState } from "./slots/allocator.js";

export const SOCKET_PATH = path.join(os.homedir(), ".config", "herdr", "herdr.sock");

export const client = new HerdrClient({ socketPath: SOCKET_PATH });
export const registry = new AgentRegistry(client);

/**
 * Mutable because it is replaced once persisted assignments load from global
 * settings. Actions must always read `allocator()` rather than capturing it.
 */
let current = new SlotAllocator();
export function allocator(): SlotAllocator {
	return current;
}

interface GlobalSettings {
	slots?: SlotAllocatorState;
	[key: string]: unknown;
}

/** Restores sticky slot assignments so they survive a Stream Deck restart. */
export async function loadSlots(): Promise<void> {
	const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
	if (settings.slots) current = new SlotAllocator(settings.slots);
}

/** Persists sticky slot assignments. Call after any claim. */
export async function saveSlots(): Promise<void> {
	const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
	await streamDeck.settings.setGlobalSettings({ ...settings, slots: current.toJSON() });
}

export async function startHerdr(): Promise<void> {
	try {
		await client.connect();
	} catch {
		// HerdrClient schedules its own reconnect; actions render "disconnected"
		// until it succeeds.
	}
	await registry.start();
}
```

Note: `SlotAllocator` intentionally has no persistence of its own — it stays a pure, synchronously-testable object (Task 5), and all I/O lives here.

- [ ] **Step 5: Write the AgentSlot action**

Create `src/actions/agent-slot.ts`:

```ts
import streamDeck, {
	action,
	SingletonAction,
	type KeyAction,
	type WillAppearEvent,
	type WillDisappearEvent,
	type KeyDownEvent,
} from "@elgato/streamdeck";
import { registry, allocator, saveSlots, client } from "../plugin-state.js";
import { projectLabel, slotImage, slotTitle, type SlotRender } from "../slots/render.js";

export interface AgentSlotSettings {
	slotIndex?: number;
	[key: string]: unknown;
}

const PULSE_MS = 500;

@action({ UUID: "com.aaronfa.herdr-agents.slot" })
export class AgentSlotAction extends SingletonAction<AgentSlotSettings> {
	private pulseOn = false;
	private pulseTimer?: NodeJS.Timeout;

	constructor() {
		super();
		registry.on("changed", () => void this.renderAll());
	}

	override async onWillAppear(ev: WillAppearEvent<AgentSlotSettings>): Promise<void> {
		const slotIndex = ev.payload.settings.slotIndex ?? 0;
		allocator().registerSlot(slotIndex);
		this.ensurePulse();
		await this.renderAll();
	}

	override async onWillDisappear(ev: WillDisappearEvent<AgentSlotSettings>): Promise<void> {
		const slotIndex = ev.payload.settings.slotIndex ?? 0;
		allocator().unregisterSlot(slotIndex);
		if (this.actions.length === 0) this.stopPulse();
	}

	override async onKeyDown(ev: KeyDownEvent<AgentSlotSettings>): Promise<void> {
		const render = this.renderFor(ev.payload.settings.slotIndex ?? 0);
		if (render.kind !== "agent") {
			await ev.action.showAlert();
			return;
		}
		const cwd = allocator().cwdForSlot(ev.payload.settings.slotIndex ?? 0);
		const agent = cwd ? registry.getByCwd(cwd) : undefined;
		if (!agent) {
			await ev.action.showAlert();
			return;
		}
		try {
			await client.request("agent.focus", { target: agent.paneId });
		} catch {
			await ev.action.showAlert();
		}
	}

	private ensurePulse(): void {
		if (this.pulseTimer) return;
		this.pulseTimer = setInterval(() => {
			this.pulseOn = !this.pulseOn;
			void this.renderAll();
		}, PULSE_MS);
	}

	private stopPulse(): void {
		if (this.pulseTimer) clearInterval(this.pulseTimer);
		this.pulseTimer = undefined;
	}

	private renderFor(slotIndex: number): SlotRender {
		if (!registry.connected) return { kind: "disconnected" };

		// Claim on demand: any agent whose cwd has no slot yet takes the lowest free one.
		let claimed = false;
		for (const agent of registry.agents) {
			if (allocator().slotForCwd(agent.cwd) === undefined) {
				if (allocator().claim(agent.cwd) !== undefined) claimed = true;
			}
		}
		if (claimed) void saveSlots();

		const cwd = allocator().cwdForSlot(slotIndex);
		if (!cwd) return { kind: "unclaimed" };

		const agent = registry.getByCwd(cwd);
		if (!agent) return { kind: "reserved", project: projectLabel(cwd) };

		return {
			kind: "agent",
			status: agent.status,
			agent: agent.agent,
			project: projectLabel(agent.cwd),
		};
	}

	private async renderAll(): Promise<void> {
		for (const instance of this.actions) {
			if (!instance.isKey()) continue;
			const key = instance as KeyAction<AgentSlotSettings>;
			const settings = await key.getSettings();
			const render = this.renderFor(settings.slotIndex ?? 0);
			await key.setImage(slotImage(render, this.pulseOn));
			await key.setTitle(slotTitle(render));
		}
	}
}

export { streamDeck };
```

Note: verify `instance.isKey()` exists on the union of `DialAction | KeyAction` in `@elgato/streamdeck` 2.1.0. If it does not, discriminate with `"setImage" in instance` instead.

- [ ] **Step 6: Write the Approve and Deny actions**

Create `src/actions/approve.ts`:

```ts
import { action, SingletonAction, type KeyDownEvent } from "@elgato/streamdeck";
import { client, registry } from "../plugin-state.js";
import { decideApproval } from "./approval.js";
import type { KeySequence } from "../keymap/keymap.js";

export interface ApprovalSettings {
	override?: Partial<KeySequence>;
	[key: string]: unknown;
}

@action({ UUID: "com.aaronfa.herdr-agents.approve" })
export class ApproveAction extends SingletonAction<ApprovalSettings> {
	override async onKeyDown(ev: KeyDownEvent<ApprovalSettings>): Promise<void> {
		const decision = decideApproval({
			connected: registry.connected,
			focused: registry.focused,
			intent: "approve",
			override: ev.payload.settings.override,
		});

		if (!decision.ok) {
			await ev.action.showAlert();
			return;
		}

		try {
			await client.request("pane.send_keys", {
				pane_id: decision.paneId,
				keys: decision.keys,
			});
			await ev.action.showOk();
		} catch {
			await ev.action.showAlert();
		}
	}
}
```

Create `src/actions/deny.ts` — identical except for the UUID and intent:

```ts
import { action, SingletonAction, type KeyDownEvent } from "@elgato/streamdeck";
import { client, registry } from "../plugin-state.js";
import { decideApproval } from "./approval.js";
import type { ApprovalSettings } from "./approve.js";

@action({ UUID: "com.aaronfa.herdr-agents.deny" })
export class DenyAction extends SingletonAction<ApprovalSettings> {
	override async onKeyDown(ev: KeyDownEvent<ApprovalSettings>): Promise<void> {
		const decision = decideApproval({
			connected: registry.connected,
			focused: registry.focused,
			intent: "deny",
			override: ev.payload.settings.override,
		});

		if (!decision.ok) {
			await ev.action.showAlert();
			return;
		}

		try {
			await client.request("pane.send_keys", {
				pane_id: decision.paneId,
				keys: decision.keys,
			});
			await ev.action.showOk();
		} catch {
			await ev.action.showAlert();
		}
	}
}
```

- [ ] **Step 7: Wire the entrypoint**

Replace `src/plugin.ts`:

```ts
import streamDeck from "@elgato/streamdeck";
import { AgentSlotAction } from "./actions/agent-slot.js";
import { ApproveAction } from "./actions/approve.js";
import { DenyAction } from "./actions/deny.js";
import { loadSlots, startHerdr } from "./plugin-state.js";

streamDeck.actions.registerAction(new AgentSlotAction());
streamDeck.actions.registerAction(new ApproveAction());
streamDeck.actions.registerAction(new DenyAction());

await streamDeck.connect();
// Must precede startHerdr: the first render claims slots, and it must claim
// against restored assignments rather than an empty allocator.
await loadSlots();
await startHerdr();
```

- [ ] **Step 8: Add the actions to the manifest**

Replace the `"Actions": []` array in `com.aaronfa.herdr-agents.sdPlugin/manifest.json`:

```json
	"Actions": [
		{
			"UUID": "com.aaronfa.herdr-agents.slot",
			"Name": "Agent Slot",
			"Icon": "imgs/actions/slot",
			"Tooltip": "Shows one herdr agent's state. Press to focus its pane.",
			"PropertyInspectorPath": "ui/agent-slot.html",
			"Controllers": ["Keypad"],
			"States": [{ "Image": "imgs/actions/slot", "TitleAlignment": "bottom" }]
		},
		{
			"UUID": "com.aaronfa.herdr-agents.approve",
			"Name": "Approve",
			"Icon": "imgs/actions/approve",
			"Tooltip": "Approve the focused agent's pending request. Only acts when it is blocked.",
			"Controllers": ["Keypad"],
			"States": [{ "Image": "imgs/actions/approve" }]
		},
		{
			"UUID": "com.aaronfa.herdr-agents.deny",
			"Name": "Deny",
			"Icon": "imgs/actions/deny",
			"Tooltip": "Deny the focused agent's pending request. Only acts when it is blocked.",
			"Controllers": ["Keypad"],
			"States": [{ "Image": "imgs/actions/deny" }]
		}
	]
```

- [ ] **Step 9: Create the property inspector**

Create `com.aaronfa.herdr-agents.sdPlugin/ui/agent-slot.html`:

```html
<!DOCTYPE html>
<html>
	<head>
		<meta charset="utf-8" />
		<script src="https://sdpi-components.dev/releases/v4/sdpi-components.js"></script>
	</head>
	<body>
		<sdpi-item label="Slot">
			<sdpi-select setting="slotIndex" default="0">
				<option value="0">1</option>
				<option value="1">2</option>
				<option value="2">3</option>
				<option value="3">4</option>
				<option value="4">5</option>
				<option value="5">6</option>
				<option value="6">7</option>
				<option value="7">8</option>
			</sdpi-select>
		</sdpi-item>
	</body>
</html>
```

- [ ] **Step 10: Create the icon assets**

Create four 144×144 PNGs. Any simple flat-colour icon is acceptable; they are chrome, not state (state is rendered at runtime by `slotImage`).

```bash
mkdir -p com.aaronfa.herdr-agents.sdPlugin/imgs/actions
python3 - <<'PY'
import struct, zlib, os

def png(path, rgb):
    w = h = 144
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    out = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw))
           + chunk(b"IEND", b""))
    open(path, "wb").write(out)

base = "com.aaronfa.herdr-agents.sdPlugin/imgs"
png(f"{base}/plugin.png", (40, 40, 48))
png(f"{base}/actions/slot.png", (48, 48, 56))
png(f"{base}/actions/approve.png", (48, 163, 108))
png(f"{base}/actions/deny.png", (229, 72, 77))
PY
ls -l com.aaronfa.herdr-agents.sdPlugin/imgs com.aaronfa.herdr-agents.sdPlugin/imgs/actions
```

- [ ] **Step 11: Run the full test suite**

```bash
npm test
```

Expected: PASS, 49 tests. If Step 3 changed the event field name, the registry events test must have been updated to match — a failure here means that update was missed.

- [ ] **Step 12: Build and install the plugin**

```bash
npm run build
ln -sfn "$PWD/com.aaronfa.herdr-agents.sdPlugin" \
  "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.aaronfa.herdr-agents.sdPlugin"
```

Then restart the Stream Deck app. Expected: "Herdr Agents" appears in the actions list with three actions.

- [ ] **Step 13: Manual end-to-end verification**

Confirm each of these against live herdr, and record the result:

1. Place three Agent Slot keys with slot indices 0, 1, 2. With agents running in herdr, each key shows its agent name and project basename.
2. An idle agent renders green; a working agent renders amber.
3. Drive an agent to an approval prompt. Its key turns red and pulses within roughly one second.
4. Press that key. The herdr pane receives focus.
5. Press Approve. The prompt is accepted and the key returns to amber or green.
6. Press Approve again while no agent is blocked. The key shows an alert and **no keystroke reaches any pane** — verify by checking the previously-focused agent's transcript is unchanged.
7. Press Deny at an approval prompt. The prompt is rejected.
8. Stop herdr (`herdr server stop`). Within roughly five seconds every slot key shows the "no herdr" disconnected state — **not** a stale colour.
9. Restart herdr. Keys recover to live state without restarting the Stream Deck app.
10. Exit an agent. Its slot goes dark but keeps its project label. Restart an agent in the same directory. It returns to the same slot.
11. Quit and reopen the Stream Deck app. Slot assignments are unchanged — each project returns to the key it was on before. This verifies `loadSlots`/`saveSlots`; if assignments shuffle, global settings are not round-tripping.

- [ ] **Step 14: Record the resolved open items in the spec**

Edit `docs/superpowers/specs/2026-07-19-streamdeck-agent-alerts-design.md`: replace the "Open items for implementation" section with the verified findings from Steps 1–3 — the real key vocabulary, the confirmed per-agent sequences (and which ones remain unverified and therefore fall through to `default`), and the actual `pane.agent_status_changed` payload shape.

- [ ] **Step 15: Commit**

```bash
git add src com.aaronfa.herdr-agents.sdPlugin docs
git commit -m "feat: wire up agent slot, approve, and deny Stream Deck actions"
```

---

## Notes for the implementer

**On the manual verification in Step 13:** these are the only checks that exercise the real herdr protocol and the real agent CLIs. If any of them fail, the fix belongs in the corresponding unit-tested module with a new failing test first — not as a patch applied directly at the action layer.

**On step 6 of the manual verification:** this is the single most important check in the plan. It verifies the safety gate that prevents Approve from injecting keystrokes into a working agent. Do not mark it passed by reasoning about the code; actually press the key while nothing is blocked and inspect the target pane.

**If a unit test starts failing after Step 3's payload discovery,** that is the plan working as intended — the test encoded a guess, reality disagreed, and the guess loses.
