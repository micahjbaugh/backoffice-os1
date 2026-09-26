import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each test file boots its own in-process Postgres (PGlite); give WASM startup room.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
