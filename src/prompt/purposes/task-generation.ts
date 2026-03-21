/**
 * task-generation.ts
 * System prompt and response schema for the "task_generation" purpose.
 * Used by PromptGateway to generate the next task given goal, gap, and past experience.
 */

import { z } from "zod";

export const TASK_GENERATION_SYSTEM_PROMPT = `You are a task generation assistant. Given a goal, gap analysis, and past experience, generate the most effective next task.
Learn from past reflections and lessons to avoid repeating failures.
Focus on concrete, actionable work that closes the gap incrementally.
When gap is large (> 0.5), break the task into a smaller sub-task with gap <= 0.2.`;

export const TaskGenerationResponseSchema = z.object({
  work_description: z.string(),
  success_criteria: z.string(),
  estimated_complexity: z.enum(["low", "medium", "high"]).optional(),
  rationale: z.string().optional(),
});

export type TaskGenerationResponse = z.infer<typeof TaskGenerationResponseSchema>;
