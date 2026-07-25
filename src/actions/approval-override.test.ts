import { describe, expect, it } from "vitest";
import { overrideFromSettings, parseKeyList } from "./approval-override.js";

describe("parseKeyList", () => {
	it("returns undefined for absent input", () => {
		expect(parseKeyList(undefined)).toBeUndefined();
	});

	it("returns undefined for an empty string", () => {
		expect(parseKeyList("")).toBeUndefined();
	});

	it("returns undefined for a whitespace-only string", () => {
		expect(parseKeyList("   ")).toBeUndefined();
	});

	it("parses a single key", () => {
		expect(parseKeyList("Enter")).toEqual(["Enter"]);
	});

	it("splits a comma-separated list", () => {
		expect(parseKeyList("y, Enter")).toEqual(["y", "Enter"]);
	});

	it("splits a whitespace-separated list", () => {
		expect(parseKeyList("y Enter")).toEqual(["y", "Enter"]);
	});
});

describe("overrideFromSettings", () => {
	it("returns undefined when neither field is set", () => {
		expect(overrideFromSettings({})).toBeUndefined();
	});

	it("includes only the approve field when only approve is set", () => {
		expect(overrideFromSettings({ approveKeys: "y" })).toEqual({ approve: ["y"] });
	});

	it("includes both fields when both are set", () => {
		expect(overrideFromSettings({ approveKeys: "y", denyKeys: "Esc" })).toEqual({
			approve: ["y"],
			deny: ["Esc"],
		});
	});

	it("treats a blank field as unset", () => {
		expect(overrideFromSettings({ approveKeys: "  " })).toBeUndefined();
	});
});
