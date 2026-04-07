import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "openclaw/plugin-sdk/plugin-entry": resolve(
        __dirname,
        "test/stubs/openclaw-plugin-entry.js",
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
