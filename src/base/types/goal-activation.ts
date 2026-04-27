import { z } from "zod";

export const WaitResumeActivationSchema = z.object({
  type: z.literal("wait_resume"),
  strategyId: z.string(),
  scheduleEntryId: z.string().optional(),
  nextObserveAt: z.string().nullable().optional(),
  waitReason: z.string().nullable().optional(),
});

export type WaitResumeActivation = z.infer<typeof WaitResumeActivationSchema>;

export interface GoalRunActivationContext {
  waitResume?: WaitResumeActivation;
}
