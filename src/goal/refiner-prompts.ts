import type { Goal } from "../types/goal.js";

// ─── Threshold type sanitizer ───

const THRESHOLD_TYPE_MAP: Record<string, string> = {
  exact: "match",
  scale: "min",
  qualitative: "min",
  boolean: "present",
  percentage: "min",
  count: "min",
};

const VALID_THRESHOLD_TYPES = new Set(["min", "max", "range", "present", "match"]);

/**
 * Sanitizes LLM-returned threshold_type strings to valid enum values.
 * Handles the union of all known non-standard values from both
 * GoalRefiner (leaf test) and GoalTreeManager (subgoal decomposition).
 *
 * Uses regex replacement so it works on raw JSON strings before parsing.
 */
export function sanitizeThresholdTypes(raw: string): string {
  return raw.replace(
    /"threshold_type"\s*:\s*"([^"]+)"/g,
    (_match: string, val: string) => {
      if (VALID_THRESHOLD_TYPES.has(val)) return `"threshold_type": "${val}"`;
      const mapped = THRESHOLD_TYPE_MAP[val] ?? "min";
      return `"threshold_type": "${mapped}"`;
    }
  );
}

/**
 * Builds the leaf test prompt for the GoalRefiner.
 *
 * The returned prompt asks an LLM to evaluate whether the given goal is
 * directly measurable and, when it is, to specify concrete dimensions.
 */
export function buildLeafTestPrompt(
  goal: Goal,
  availableDataSources: string[]
): string {
  const constraintsSection =
    goal.constraints.length > 0
      ? `Constraints: ${goal.constraints.join(", ")}`
      : "Constraints: none";

  const dataSourcesSection =
    availableDataSources.length > 0
      ? availableDataSources.join(", ")
      : "shell, file_existence";

  return `You are evaluating whether a goal is directly measurable.

Goal: "${goal.description}"
${constraintsSection}
Available data sources: ${dataSourcesSection}
Depth: ${goal.decomposition_depth}

A goal is measurable when you can specify ALL of these for EACH aspect:
1. data_source — where to observe (shell command, file check, API, etc.)
2. observation_command — exact command or check to run
3. threshold_type — min/max/range/present/match
4. threshold_value — concrete target value

Return JSON:
{
  "is_measurable": true/false,
  "dimensions": [
    {
      "name": "snake_case_name",
      "label": "Human Label",
      "threshold_type": "min",
      "threshold_value": 80,
      "data_source": "shell",
      "observation_command": "npm test -- --coverage | grep Statements"
    }
  ],
  "reason": "Brief explanation"
}

When is_measurable is false, set "dimensions" to null.`;
}
