import { configDefaults, defineConfig } from "vitest/config";

// Tests live in src/ and tests/. `dist/` carries compiled copies of every src test, so without this
// exclusion `npm test` ran each suite twice (98 files instead of 56) and a stale build could pass or
// fail on code that no longer exists in src.
export default defineConfig({
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "dist/**", "node_modules/**"],
  },
});
