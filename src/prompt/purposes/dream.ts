export const DREAM_PATTERN_ANALYSIS_SYSTEM_PROMPT = `You analyze Dream Mode runtime traces for PulSeed.
Return valid JSON only.
Find recurring, actionable patterns supported by the evidence windows.
Favor high-signal lessons over exhaustive enumeration.
Confidence must be between 0 and 1.`;

export function buildDreamPatternAnalysisPrompt(input: {
  tier: "light" | "deep";
  goalId?: string;
  prioritizedWindows: string;
  regularWindows: string;
  importanceEntries: string;
}): string {
  return `Analyze PulSeed dream-mode iteration windows.
Tier: ${input.tier}
Goal: ${input.goalId ?? "multi-goal"}

Prioritized windows:
${input.prioritizedWindows}

Regular windows:
${input.regularWindows}

Importance entries:
${input.importanceEntries}

Return JSON:
{
  "patterns": [
    {
      "pattern_type": "string",
      "goal_id": "string optional",
      "confidence": 0.0,
      "summary": "string",
      "metadata": {},
      "evidence_refs": ["iter:goal:1"]
    }
  ]
}`;
}
