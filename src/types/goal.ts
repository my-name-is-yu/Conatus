import { z } from "zod";
import {
  ThresholdSchema,
  ObservationMethodSchema,
  AggregationTypeEnum,
  GapAggregationEnum,
  PaceStatusEnum,
  DurationSchema,
} from "./core.js";

// --- History Entry ---

export const HistoryEntrySchema = z.object({
  value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  timestamp: z.string(),
  confidence: z.number().min(0).max(1),
  source_observation_id: z.string(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

// --- Dimension ---

export const DimensionSchema = z.object({
  name: z.string(),
  label: z.string(),
  current_value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  threshold: ThresholdSchema,
  confidence: z.number().min(0).max(1),
  observation_method: ObservationMethodSchema,
  last_updated: z.string().nullable(),
  history: z.array(HistoryEntrySchema),
  /** Weight for gap aggregation (default 1.0) */
  weight: z.number().default(1.0),
  /** Per-dimension uncertainty_weight override (null = use global) */
  uncertainty_weight: z.number().nullable().default(null),
  /**
   * Integrity flag: set to "uncertain" when a revert fails so Motiva stops
   * autonomous task selection for this dimension until a human resets it.
   * See task-lifecycle.md §6.
   */
  state_integrity: z.enum(["ok", "uncertain"]).default("ok"),
});
export type Dimension = z.infer<typeof DimensionSchema>;

// --- Dimension Mapping (for sub-goal to parent propagation) ---

export const DimensionMappingSchema = z.object({
  parent_dimension: z.string(),
  aggregation: AggregationTypeEnum,
});
export type DimensionMapping = z.infer<typeof DimensionMappingSchema>;

// --- Milestone Pace Snapshot ---

export const PaceSnapshotSchema = z.object({
  elapsed_ratio: z.number(),
  achievement_ratio: z.number(),
  pace_ratio: z.number(),
  status: PaceStatusEnum,
  evaluated_at: z.string(),
});
export type PaceSnapshot = z.infer<typeof PaceSnapshotSchema>;

// --- Goal Node Type ---

export const GoalNodeTypeEnum = z.enum(["goal", "subgoal", "milestone"]);
export type GoalNodeType = z.infer<typeof GoalNodeTypeEnum>;

// --- Goal Status ---

export const GoalStatusEnum = z.enum([
  "active",
  "completed",
  "cancelled",
  "waiting",
  "archived",
]);
export type GoalStatus = z.infer<typeof GoalStatusEnum>;

// --- Goal (a node in the goal tree) ---

export const GoalSchema = z.object({
  id: z.string(),
  parent_id: z.string().nullable().default(null),
  node_type: GoalNodeTypeEnum.default("goal"),
  title: z.string(),
  description: z.string().default(""),
  status: GoalStatusEnum.default("active"),

  dimensions: z.array(DimensionSchema),
  /** Aggregation method for child goals (default: max = bottleneck) */
  gap_aggregation: GapAggregationEnum.default("max"),
  /** Dimension mapping for sub-goal to parent propagation */
  dimension_mapping: DimensionMappingSchema.nullable().default(null),

  constraints: z.array(z.string()).default([]),
  children_ids: z.array(z.string()).default([]),

  // Milestone-specific fields
  target_date: z.string().nullable().default(null),
  origin: z
    .enum(["negotiation", "decomposition", "manual"])
    .nullable()
    .default(null),
  pace_snapshot: PaceSnapshotSchema.nullable().default(null),

  // Deadline & scheduling
  deadline: z.string().nullable().default(null),

  // Negotiation metadata
  confidence_flag: z.enum(["high", "medium", "low"]).nullable().default(null),
  user_override: z.boolean().default(false),
  feasibility_note: z.string().nullable().default(null),

  // Global uncertainty_weight for gap calculation (default: 1.0)
  uncertainty_weight: z.number().default(1.0),

  // Timing
  created_at: z.string(),
  updated_at: z.string(),
});
export type Goal = z.infer<typeof GoalSchema>;

// --- Goal Tree (collection of goals for a top-level goal) ---

export const GoalTreeSchema = z.object({
  root_id: z.string(),
  goals: z.record(z.string(), GoalSchema),
});
export type GoalTree = z.infer<typeof GoalTreeSchema>;
