import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Only Crossbar's own tests — never the vendored Pi reference clone.
    include: ["tests/**/*.test.ts"],
    exclude: [".pi-reference/**", "node_modules/**", "dist/**"],
  },
});
