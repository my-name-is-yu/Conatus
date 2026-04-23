import { defineConfig } from "vitest/config";
import {
  fullInclude,
  integrationInclude,
  sharedCoverage,
  sharedResolve,
} from "./vitest.patterns.js";

export default defineConfig({
  test: {
    globals: true,
    root: ".",
    include: fullInclude,
    exclude: integrationInclude,
    coverage: sharedCoverage,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: sharedResolve,
});
