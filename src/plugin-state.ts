import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import streamDeck from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { AgentRegistry } from "./agents/registry.js";
import { HerdrClient } from "./herdr/client.js";
import { DEFAULT_KEYMAP, normalizeKeymapTable, type KeymapTable } from "./keymap/keymap.js";
import { SlotAllocator, type SlotAllocatorState } from "./slots/allocator.js";
import { sanitizeSlotAllocatorState } from "./slots/state.js";

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

// See the matching comment in agent-slot.ts for why this needs an explicit
// JsonValue index signature rather than `unknown`. `slots` is typed as an
// inline structural mirror of SlotAllocatorState (rather than that named
// type directly) because TypeScript only synthesizes an implicit index
// signature for comparability against JsonObject on fresh/structural object
// types, not on a named interface reference - SlotAllocatorState itself
// deliberately carries no index signature (it's SlotAllocator's pure,
// non-JSON-aware state shape), so this settings-layer type states the JSON
// contract separately rather than pushing an SDK-only constraint onto it.
interface GlobalSettings {
	slots?: { assignments: Record<string, number> };
	[key: string]: JsonValue | undefined;
}

/** Restores sticky slot assignments so they survive a Stream Deck restart. */
export async function loadSlots(): Promise<void> {
	const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
	if (!settings.slots) return;

	// Global settings round-trip through Stream Deck as arbitrary JSON, so
	// treat the persisted blob the same as any other untrusted input:
	// SlotAllocator itself does no validation of constructor-supplied state
	// (Task 5), so this is the one place that guards it before construction.
	const { state, warnings } = sanitizeSlotAllocatorState(settings.slots);
	for (const warning of warnings) streamDeck.logger.warn(warning);
	current = new SlotAllocator(state);
}

// Finding 2: `saveSlots()` is a read-modify-write against a single global
// settings blob (getGlobalSettings -> spread -> setGlobalSettings). Two
// overlapping calls each read the same pre-write snapshot, and whichever
// `setGlobalSettings` lands last wins - the other call's intended write is
// silently lost, which is how a slot assignment fails to survive a Stream
// Deck restart despite `saveSlots()` having been "called". `agent-slot.ts`
// no longer calls this once per key per render (see claimUnassignedAgents'
// doc comment), but any caller could still fire it more than once in quick
// succession (e.g. two "changed" events close together), so the guarantee
// has to live here, not just in the caller.
//
// `saveInFlight` serializes every call through a single chain - no two
// read-modify-write cycles ever run concurrently - and `saveQueued`
// coalesces a burst: a call that arrives while a save is already running
// just flags that one more cycle is needed, rather than enqueuing its own
// full round trip. The in-flight cycle, on completing, checks that flag and
// - if set - loops for exactly one more cycle before resolving, reading
// `current` fresh each time (never memoized), so that extra cycle always
// picks up whatever state accumulated while it was waiting, including from
// other saveSlots() calls that arrived in between. A caller's returned
// promise only resolves once its own write (or a fresher one made after it
// arrived) has actually landed.
let saveInFlight: Promise<void> | undefined;
let saveQueued = false;

/** Persists sticky slot assignments. Call after any claim; see the
 * serialization/coalescing comment above `saveInFlight` for why calling
 * this more than once in a row is safe. */
export function saveSlots(): Promise<void> {
	if (saveInFlight) {
		saveQueued = true;
		return saveInFlight;
	}
	saveInFlight = runSaveCycle().finally(() => {
		saveInFlight = undefined;
	});
	return saveInFlight;
}

async function runSaveCycle(): Promise<void> {
	do {
		saveQueued = false;
		const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
		// Spread the persisted SlotAllocatorState into a fresh object literal
		// (rather than passing `current.toJSON()`'s return value directly) so
		// `slots` is a structural literal type here too - see the GlobalSettings
		// comment above for why the named SlotAllocatorState type itself can't
		// satisfy JsonObject directly.
		await streamDeck.settings.setGlobalSettings({
			...settings,
			slots: { assignments: { ...current.toJSON().assignments } },
		});
	} while (saveQueued);
}

let keymap: KeymapTable = DEFAULT_KEYMAP;
export function keymapTable(): KeymapTable {
	return keymap;
}

/**
 * Loads the shipped keymap.json so a new agent CLI is a config edit rather
 * than a rebuild. Falls back to DEFAULT_KEYMAP if the file is missing,
 * unparsable, or fails validation (normalizeKeymapTable itself already
 * degrades an individually-bad entry rather than the whole table — see its
 * doc comment) — a broken config must not stop the plugin from starting.
 */
export function loadKeymap(): void {
	const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "keymap.json");
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		const { table, warnings } = normalizeKeymapTable(parsed);
		for (const warning of warnings) streamDeck.logger.warn(warning);
		keymap = table;
	} catch (err) {
		streamDeck.logger.warn(`could not load keymap.json, using built-in keymap: ${err}`);
	}
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
