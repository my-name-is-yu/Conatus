/**
 * purposes/index.ts
 * Re-exports all purpose modules and provides the PURPOSE_CONFIGS map.
 */

export * from "./observation.js";
export * from "./task-generation.js";
export * from "./verification.js";
export * from "./strategy.js";
export * from "./goal-decomposition.js";

import type { ContextPurpose } from "../slot-definitions.js";
import { OBSERVATION_SYSTEM_PROMPT } from "./observation.js";
import { TASK_GENERATION_SYSTEM_PROMPT } from "./task-generation.js";
import { VERIFICATION_SYSTEM_PROMPT } from "./verification.js";
import { STRATEGY_SYSTEM_PROMPT } from "./strategy.js";
import { GOAL_DECOMPOSITION_SYSTEM_PROMPT } from "./goal-decomposition.js";

export interface PurposeConfig {
  systemPrompt: string;
  defaultMaxTokens: number;
  defaultTemperature: number;
}

export const PURPOSE_CONFIGS: Record<ContextPurpose, PurposeConfig> = {
  observation: {
    systemPrompt: OBSERVATION_SYSTEM_PROMPT,
    defaultMaxTokens: 512,
    defaultTemperature: 0,
  },
  task_generation: {
    systemPrompt: TASK_GENERATION_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0,
  },
  verification: {
    systemPrompt: VERIFICATION_SYSTEM_PROMPT,
    defaultMaxTokens: 1024,
    defaultTemperature: 0,
  },
  strategy_generation: {
    systemPrompt: STRATEGY_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0.2,
  },
  goal_decomposition: {
    systemPrompt: GOAL_DECOMPOSITION_SYSTEM_PROMPT,
    defaultMaxTokens: 2048,
    defaultTemperature: 0,
  },
};
