import nodeResolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";

const sdPlugin = "com.aaronfa.herdr-agents.sdPlugin";

export default {
	input: "src/plugin.ts",
	output: {
		file: `${sdPlugin}/bin/plugin.js`,
		format: "es",
		sourcemap: true,
	},
	plugins: [
		typescript({ tsconfig: "./tsconfig.json" }),
		nodeResolve({ preferBuiltins: true }),
		commonjs(),
	],
	external: ["node:net", "node:os", "node:path", "node:events", "node:fs"],
};
