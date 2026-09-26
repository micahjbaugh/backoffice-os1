import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The bundle test runs a full production build.
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
