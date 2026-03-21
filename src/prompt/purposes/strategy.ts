/**
 * strategy.ts
 * System prompt and response schema for the "strategy_generation" purpose.
 * Used by PromptGateway to generate candidate strategies for achieving a goal.
 */

import { z } from "zod";

export const STRATEGY_SYSTEM_PROMPT = `Generate candidate strategies for achieving the goal.
Consider past lessons, strategy templates from similar goals, and the current gap.
Each strategy should have a testable hypothesis and a clear approach.
Prefer strategies that have succeeded on similar goals when templates are available.`;

export const StrategyResponseSchema = z.object({
  candidates: z.array(
    z.object({
      hypothesis: z.string(),
      approach: z.string(),
      estimated_impact: z.number().min(0).max(1).optional(),
      rationale: z.string().optional(),
    })
  ),
});

export type StrategyResponse = z.infer<typeof StrategyResponseSchema>;
