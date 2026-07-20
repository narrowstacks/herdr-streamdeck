import { describe, expect, it } from "vitest";
import { PLUGIN_UUID } from "./version.js";

describe("PLUGIN_UUID", () => {
	it("matches the plugin directory name", () => {
		expect(PLUGIN_UUID).toBe("com.aaronfa.herdr-agents");
	});
});
