import { describe, expect, it } from "vitest";
import { DEFAULT_KEYMAP, normalizeKeymapTable, resolveKeymap, type KeymapTable } from "./keymap.js";

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

	it("does not throw when the table's default entry is missing", () => {
		const brokenTable = {
			weird: { approve: ["y"], deny: ["n"] },
		} as unknown as KeymapTable;
		expect(resolveKeymap("unknown-agent", brokenTable)).toEqual(DEFAULT_KEYMAP.default);
	});

	it("falls back to the table's default for a field missing on the agent entry", () => {
		const partialTable = {
			weird: { approve: ["y"] },
			default: { approve: ["Enter"], deny: ["Escape"] },
		} as unknown as KeymapTable;
		expect(resolveKeymap("weird", partialTable)).toEqual({ approve: ["y"], deny: ["Escape"] });
	});

	it("does not throw when agentLabel is not a string", () => {
		expect(resolveKeymap(42 as unknown as string, TABLE)).toEqual(TABLE.default);
	});

	it("does not throw and degrades to DEFAULT_KEYMAP when table is null", () => {
		expect(resolveKeymap("claude", null as unknown as KeymapTable)).toEqual(
			DEFAULT_KEYMAP.default,
		);
	});

	it("does not throw and degrades to DEFAULT_KEYMAP when table is a non-object primitive (number)", () => {
		expect(resolveKeymap("claude", 42 as unknown as KeymapTable)).toEqual(DEFAULT_KEYMAP.default);
	});

	it("does not throw and degrades to DEFAULT_KEYMAP when table is a non-object primitive (string)", () => {
		expect(resolveKeymap("claude", "not-a-table" as unknown as KeymapTable)).toEqual(
			DEFAULT_KEYMAP.default,
		);
	});

	it("never ships 'Escape' in DEFAULT_KEYMAP - herdr's pane.send_keys rejects it (accepts 'Esc')", () => {
		const serialized = JSON.stringify(DEFAULT_KEYMAP);
		expect(serialized).not.toContain("Escape");
	});
});

describe("normalizeKeymapTable", () => {
	it("passes through a well-formed table unchanged, minus warnings", () => {
		const raw = {
			claude: { approve: ["Enter"], deny: ["Esc"] },
			default: { approve: ["Enter"], deny: ["Esc"] },
		};
		const { table, warnings } = normalizeKeymapTable(raw);
		expect(table).toEqual(raw);
		expect(warnings).toEqual([]);
	});

	it("strips the _comment key", () => {
		const raw = {
			_comment: "explanatory text",
			default: { approve: ["Enter"], deny: ["Esc"] },
		};
		const { table } = normalizeKeymapTable(raw);
		expect(table).not.toHaveProperty("_comment");
		expect(table.default).toEqual({ approve: ["Enter"], deny: ["Esc"] });
	});

	it("lowercases agent-label keys so a hand-edited 'Claude' entry actually matches lookups", () => {
		const raw = {
			Claude: { approve: ["Enter"], deny: ["Esc"] },
			default: { approve: ["Enter"], deny: ["Esc"] },
		};
		const { table, warnings } = normalizeKeymapTable(raw);
		expect(table.claude).toEqual({ approve: ["Enter"], deny: ["Esc"] });
		expect(table).not.toHaveProperty("Claude");
		expect(warnings).toEqual([]);
		// And the normalized table actually resolves the way a human editing
		// "Claude" by hand would expect.
		expect(resolveKeymap("claude", table)).toEqual({ approve: ["Enter"], deny: ["Esc"] });
	});

	it("drops an entry whose approve list is an empty array, with a warning", () => {
		const raw = {
			claude: { approve: [], deny: ["Esc"] },
			default: { approve: ["Enter"], deny: ["Esc"] },
		};
		const { table, warnings } = normalizeKeymapTable(raw);
		expect(table).not.toHaveProperty("claude");
		expect(warnings.some((w) => w.includes("claude"))).toBe(true);
	});

	it("drops an entry whose deny list is missing entirely, with a warning", () => {
		const raw = {
			claude: { approve: ["Enter"] },
			default: { approve: ["Enter"], deny: ["Esc"] },
		};
		const { table, warnings } = normalizeKeymapTable(raw);
		expect(table).not.toHaveProperty("claude");
		expect(warnings.length).toBe(1);
	});

	it("drops an entry that is not an object at all", () => {
		const raw = {
			claude: "Enter",
			default: { approve: ["Enter"], deny: ["Esc"] },
		};
		const { table, warnings } = normalizeKeymapTable(raw);
		expect(table).not.toHaveProperty("claude");
		expect(warnings.length).toBe(1);
	});

	it("keeps the first entry and drops the second on a case-insensitive key collision", () => {
		const raw = {
			claude: { approve: ["Enter"], deny: ["Esc"] },
			Claude: { approve: ["y"], deny: ["n"] },
			default: { approve: ["Enter"], deny: ["Esc"] },
		};
		const { table, warnings } = normalizeKeymapTable(raw);
		expect(table.claude).toEqual({ approve: ["Enter"], deny: ["Esc"] });
		expect(warnings.some((w) => w.includes("duplicate"))).toBe(true);
	});

	it("falls back to DEFAULT_KEYMAP when the input is not an object", () => {
		for (const bad of [null, 42, "nope", [1, 2, 3]]) {
			const { table, warnings } = normalizeKeymapTable(bad);
			expect(table).toBe(DEFAULT_KEYMAP);
			expect(warnings.length).toBeGreaterThan(0);
		}
	});

	it("falls back to DEFAULT_KEYMAP when no valid 'default' entry survives validation", () => {
		const raw = { claude: { approve: ["Enter"], deny: ["Esc"] } };
		const { table, warnings } = normalizeKeymapTable(raw);
		expect(table).toBe(DEFAULT_KEYMAP);
		expect(warnings.length).toBeGreaterThan(0);
	});

	it("falls back to DEFAULT_KEYMAP when 'default' itself has an empty key list", () => {
		const raw = { default: { approve: ["Enter"], deny: [] } };
		const { table, warnings } = normalizeKeymapTable(raw);
		expect(table).toBe(DEFAULT_KEYMAP);
		expect(warnings.length).toBeGreaterThan(0);
	});

	it("never throws on deeply malformed input", () => {
		expect(() => normalizeKeymapTable(undefined)).not.toThrow();
		expect(() => normalizeKeymapTable({ a: null, b: 1, c: [1, 2] })).not.toThrow();
	});
});
