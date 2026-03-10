import { z } from "zod";
import {
  ObservationTriggerEnum,
  ObservationLayerEnum,
  ObservationMethodSchema,
} from "./core.js";

// --- Observation Log Entry ---

export const ObservationLogEntrySchema = z.object({
  observation_id: z.string(),
  timestamp: z.string(),
  trigger: ObservationTriggerEnum,
  goal_id: z.string(),
  dimension_name: z.string(),
  layer: ObservationLayerEnum,
  method: ObservationMethodSchema,
  raw_result: z.unknown(),
  extracted_value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  confidence: z.number().min(0).max(1),
  notes: z.string().nullable().default(null),
});
export type ObservationLogEntry = z.infer<typeof ObservationLogEntrySchema>;

// --- Observation Log (collection for a goal) ---

export const ObservationLogSchema = z.object({
  goal_id: z.string(),
  entries: z.array(ObservationLogEntrySchema),
});
export type ObservationLog = z.infer<typeof ObservationLogSchema>;
