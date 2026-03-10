import { z } from "zod";

// --- Dissatisfaction Drive Score ---

export const DissatisfactionScoreSchema = z.object({
  dimension_name: z.string(),
  normalized_weighted_gap: z.number(),
  decay_factor: z.number(),
  score: z.number(),
});
export type DissatisfactionScore = z.infer<typeof DissatisfactionScoreSchema>;

// --- Deadline Drive Score ---

export const DeadlineScoreSchema = z.object({
  dimension_name: z.string(),
  normalized_weighted_gap: z.number(),
  urgency: z.number(),
  score: z.number(),
});
export type DeadlineScore = z.infer<typeof DeadlineScoreSchema>;

// --- Opportunity Drive Score ---

export const OpportunityScoreSchema = z.object({
  dimension_name: z.string(),
  opportunity_value: z.number(),
  freshness_decay: z.number(),
  score: z.number(),
});
export type OpportunityScore = z.infer<typeof OpportunityScoreSchema>;

// --- Final Drive Score (per dimension) ---

export const DriveScoreSchema = z.object({
  dimension_name: z.string(),
  dissatisfaction: z.number(),
  deadline: z.number(),
  opportunity: z.number(),
  final_score: z.number(),
  dominant_drive: z.enum(["dissatisfaction", "deadline", "opportunity"]),
});
export type DriveScore = z.infer<typeof DriveScoreSchema>;

// --- Drive Configuration ---

export const DriveConfigSchema = z.object({
  // Dissatisfaction drive
  decay_floor: z.number().default(0.3),
  recovery_time_hours: z.number().default(24),
  // Deadline drive
  deadline_horizon_hours: z.number().default(168),
  urgency_steepness: z.number().default(3.0),
  urgency_override_threshold: z.number().default(10.0),
  // Opportunity drive
  half_life_hours: z.number().default(12),
});
export type DriveConfig = z.infer<typeof DriveConfigSchema>;

// --- Event (for drive system) ---

export const MotivaEventSchema = z.object({
  type: z.enum(["external", "internal"]),
  source: z.string(),
  timestamp: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type MotivaEvent = z.infer<typeof MotivaEventSchema>;
