/**
 * goal-validation.ts — Validation helpers and dimension transformation utilities
 * used by GoalNegotiator and related modules.
 */

import type { Dimension } from "../../base/types/goal.js";
import type { DimensionDecomposition } from "../../base/types/negotiation.js";

// ─── Helper: convert DimensionDecomposition to Dimension ───

export function decompositionToDimension(d: DimensionDecomposition): Dimension {
  const threshold = buildThreshold(d.threshold_type, d.threshold_value);
  return {
    name: d.name,
    label: d.label,
    current_value: null,
    threshold,
    confidence: 0,
    observation_method: {
      type: "llm_review",
      source: d.observation_method_hint,
      schedule: null,
      endpoint: null,
      confidence_tier: "self_report",
    },
    last_updated: null,
    history: [],
    weight: 1.0,
    uncertainty_weight: null,
    state_integrity: "ok",
    observation_mapping: d.dimension_mapping ?? null,
    dimension_mapping: null,
  };
}

export function buildThreshold(
  thresholdType: "min" | "max" | "range" | "present" | "match",
  thresholdValue: number | string | boolean | (number | string)[] | null
): Dimension["threshold"] {
  switch (thresholdType) {
    case "min":
      return { type: "min", value: typeof thresholdValue === "number" ? thresholdValue : 0 };
    case "max":
      return { type: "max", value: typeof thresholdValue === "number" ? thresholdValue : 100 };
    case "range": {
      if (Array.isArray(thresholdValue)) {
        const low = typeof thresholdValue[0] === "number" ? thresholdValue[0] : 0;
        const high = typeof thresholdValue[1] === "number" ? thresholdValue[1] : 100;
        return { type: "range", low, high };
      }
      return { type: "range", low: 0, high: typeof thresholdValue === "number" ? thresholdValue : 100 };
    }
    case "present":
      return { type: "present" };
    case "match":
      return {
        type: "match",
        value:
          thresholdValue !== null && !Array.isArray(thresholdValue)
            ? (thresholdValue as string | number | boolean)
            : "",
      };
  }
}

// ─── Helper: deduplicate dimension keys ───

/**
 * When the LLM returns multiple dimensions with the same `name` (key),
 * append `_2`, `_3`, … suffixes to the duplicates so every key is unique.
 * All dimensions are preserved — none are dropped.
 */
export function deduplicateDimensionKeys(dimensions: DimensionDecomposition[]): DimensionDecomposition[] {
  const seen = new Map<string, number>(); // key → count so far
  for (const dim of dimensions) {
    const base = dim.name;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    if (count > 0) {
      // Second occurrence → `_2`, third → `_3`, etc.
      dim.name = `${base}_${count + 1}`;
    }
  }
  return dimensions;
}

export function validateDataSourceDimensionMappings(
  dimensions: DimensionDecomposition[],
  availableDataSources: Array<{ name: string; dimensions: string[] }>
): DimensionDecomposition[] {
  const sources = new Map(availableDataSources.map((source) => [source.name, new Set(source.dimensions)]));

  for (const dimension of dimensions) {
    const mapping = dimension.dimension_mapping;
    if (!mapping) continue;

    const sourceDimensions = sources.get(mapping.data_source);
    if (!sourceDimensions?.has(mapping.dimension)) {
      dimension.dimension_mapping = null;
    }
  }

  return dimensions;
}
