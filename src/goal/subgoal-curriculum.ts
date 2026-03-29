/**
 * Difficulty-based curriculum ordering for subgoal selection.
 * Prioritizes medium-complexity (0.3-0.7) subgoals using gap × (1 - confidence).
 */

import type { Goal } from "../types/goal.js";
import { computeRawGap, normalizeGap } from "../drive/gap-calculator.js";

/** Preferred difficulty band for curriculum-based selection. */
export const MEDIUM_BAND = { min: 0.3, max: 0.7 };

/**
 * Estimate difficulty for a single goal.
 * difficulty = aggregatedGap × (1 - aggregatedConfidence), clamped to [0, 1].
 * Returns 0.5 (medium) when dimensions is empty.
 */
export function estimateDifficulty(goal: Goal): number {
  const dims = goal.dimensions;
  if (dims.length === 0) return 0.5;

  // Compute normalized gap per dimension
  const gapValues: number[] = [];
  const weights: number[] = [];
  const confidences: number[] = [];

  for (const d of dims) {
    let normalizedGap: number;
    if (d.current_value === null) {
      normalizedGap = 1.0;
    } else {
      const raw = computeRawGap(d.current_value, d.threshold);
      normalizedGap = normalizeGap(raw, d.threshold, d.current_value);
    }
    gapValues.push(Math.min(1, Math.max(0, normalizedGap)));
    weights.push(d.weight ?? 1.0);
    confidences.push(d.confidence);
  }

  // Aggregate gap by goal's gap_aggregation setting
  let aggregatedGap: number;
  const agg = goal.gap_aggregation;
  if (agg === "max") {
    aggregatedGap = Math.max(...gapValues);
  } else if (agg === "weighted_avg") {
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    if (totalWeight === 0) {
      aggregatedGap = 0;
    } else {
      aggregatedGap = gapValues.reduce((s, g, i) => s + g * weights[i], 0) / totalWeight;
    }
  } else {
    // "sum" — capped at 1
    aggregatedGap = Math.min(1, gapValues.reduce((s, g) => s + g, 0));
  }

  // Aggregate confidence: most conservative (minimum)
  const aggregatedConfidence = Math.min(...confidences);

  const difficulty = aggregatedGap * (1 - aggregatedConfidence);
  return Math.min(1, Math.max(0, difficulty));
}

/**
 * Sort subgoal entries in-place using center-biased curriculum ordering.
 * Primary: |difficulty - 0.5| ascending (closest to medium first).
 * Tiebreaker: depth descending (deeper first).
 */
export function curriculumSort(
  entries: Array<{ id: string; depth: number; difficulty: number }>
): void {
  entries.sort((a, b) => {
    const aDist = Math.abs(a.difficulty - 0.5);
    const bDist = Math.abs(b.difficulty - 0.5);
    if (aDist !== bDist) return aDist - bDist;
    return b.depth - a.depth;
  });
}
