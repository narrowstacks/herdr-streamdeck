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
});
