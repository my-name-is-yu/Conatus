export * from "./types/index.js";
export { StateManager } from "./state-manager.js";
export {
  computeRawGap,
  normalizeGap,
  applyConfidenceWeight,
  calculateDimensionGap,
  calculateGapVector,
  aggregateGaps,
} from "./gap-calculator.js";
export type { DimensionGapInput } from "./gap-calculator.js";
