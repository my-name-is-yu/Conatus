import { z } from "zod";

export const HeartbeatCheckTypeSchema = z.enum(["http", "tcp", "process", "disk", "custom"]);

export const HeartbeatConfigSchema = z.object({
  check_type: HeartbeatCheckTypeSchema,
  check_config: z.record(z.unknown()),
  failure_threshold: z.number().int().min(1).default(3),
  timeout_ms: z.number().int().min(100).default(5000),
});

export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;

export const ScheduleLayerSchema = z.enum(["heartbeat", "probe", "cron", "goal_trigger"]);

export const ScheduleTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cron"), expression: z.string() }),
  z.object({ type: z.literal("interval"), seconds: z.number().int().min(1) }),
]);

export const ScheduleEntrySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  layer: ScheduleLayerSchema,
  trigger: ScheduleTriggerSchema,
  enabled: z.boolean().default(true),
  heartbeat: HeartbeatConfigSchema.optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_fired_at: z.string().datetime().nullable().default(null),
  next_fire_at: z.string().datetime(),
  consecutive_failures: z.number().int().default(0),
  total_executions: z.number().int().default(0),
  total_tokens_used: z.number().int().default(0),
});

export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;

export const ScheduleEntryListSchema = z.array(ScheduleEntrySchema);

export const ScheduleResultSchema = z.object({
  entry_id: z.string().uuid(),
  status: z.enum(["success", "failure", "skipped"]),
  duration_ms: z.number(),
  error_message: z.string().optional(),
  fired_at: z.string().datetime(),
});

export type ScheduleResult = z.infer<typeof ScheduleResultSchema>;
