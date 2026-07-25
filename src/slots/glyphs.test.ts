import { describe, expect, it } from "vitest";
import {
	agentHero,
	blockedBadge,
	checkHero,
	crossHero,
	disconnectedGlyph,
	idleBadge,
	workingBadge,
} from "./glyphs.js";

// Every glyph is spliced into a `<svg ... viewBox="0 0 72 72">`, so these tests
// assert on the SVG fragment strings directly (no data-URI decode needed). The
// goal is to lock the shared vocabulary so later plans wiring it into render.ts
// and the static icons all draw the same mark for the same concept.

const allFragments: Record<string, string> = {
	checkHero: checkHero(),
	crossHero: crossHero(),
	disconnectedGlyph: disconnectedGlyph(),
	agentHero: agentHero(),
	blockedBadge: blockedBadge(),
	workingBadge: workingBadge(),
	idleBadge: idleBadge(),
};

describe("glyph fragments", () => {
	it("every glyph returns a non-empty string", () => {
		for (const [name, fragment] of Object.entries(allFragments)) {
			expect(fragment, name).toBeTruthy();
			expect(fragment.length, name).toBeGreaterThan(0);
		}
	});

	it("no fragment contains the literal 'undefined'", () => {
		for (const [name, fragment] of Object.entries(allFragments)) {
			expect(fragment, name).not.toContain("undefined");
		}
	});
});

describe("checkHero", () => {
	it("uses white as the default stroke", () => {
		expect(checkHero()).toContain('stroke="#ffffff"');
	});

	it("honours a custom stroke colour", () => {
		expect(checkHero("#141414")).toContain('stroke="#141414"');
	});
});

describe("crossHero", () => {
	it("draws both diagonals of the X", () => {
		expect(crossHero()).toContain("L47 47");
		expect(crossHero()).toContain("L25 47");
	});
});

describe("blockedBadge", () => {
	it("defaults to the top-right corner", () => {
		const badge = blockedBadge();
		expect(badge).toContain('cx="60"');
		expect(badge).toContain('cy="12"');
	});

	it("can be positioned anywhere", () => {
		const badge = blockedBadge(36, 40);
		expect(badge).toContain('cx="36"');
		expect(badge).toContain('cy="40"');
	});
});

describe("agentHero", () => {
	it("contains all three status colours", () => {
		const hero = agentHero();
		expect(hero).toContain("#e5484d");
		expect(hero).toContain("#f5a524");
		expect(hero).toContain("#30a46c");
	});
});

describe("badge shapes stay distinct", () => {
	it("working and idle badges differ by shape, not just colour", () => {
		expect(workingBadge()).not.toBe(idleBadge());
	});
});
