import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { writeJsonFileAtomic, readJsonFileOrNull } from "../../base/utils/json-io.js";
import { ScheduleEntrySchema, type ScheduleEntry } from "../types/schedule.js";
import { computeNextFireAt } from "./engine-mutations.js";

const LEGACY_CRON_TASKS_FILE = "scheduled-tasks.json";
const LEGACY_CRON_TASKS_ARCHIVE_FILE = "scheduled-tasks.legacy-migrated.json";
const SCHEDULES_FILE = "schedules.json";

const LegacyCronTaskListSchema = z.array(z.object({
  id: z.string().uuid(),
  cron: z.string(),
  prompt: z.string(),
  type: z.enum(["reflection", "consolidation", "custom"]),
  enabled: z.boolean().default(true),
  last_fired_at: z.string().datetime().nullable(),
  permanent: z.boolean(),
  created_at: z.string().datetime(),
}));

export interface LegacyCronMigrationLogger {
  info?: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
}

export async function migrateLegacyCronTasksIfNeeded(params: {
  baseDir: string;
  logger: LegacyCronMigrationLogger;
}): Promise<boolean> {
  const legacyPath = path.join(params.baseDir, LEGACY_CRON_TASKS_FILE);
  const archivePath = path.join(params.baseDir, LEGACY_CRON_TASKS_ARCHIVE_FILE);
  const schedulesPath = path.join(params.baseDir, SCHEDULES_FILE);

  const existingSchedules = await readJsonFileOrNull(schedulesPath);
  if (existingSchedules !== null) {
    return false;
  }

  const legacyRaw = await readJsonFileOrNull(legacyPath);
  if (legacyRaw === null) {
    return false;
  }

  const parsed = LegacyCronTaskListSchema.safeParse(legacyRaw);
  if (!parsed.success) {
    params.logger.warn("Ignoring invalid legacy scheduled-tasks.json during schedule migration", {
      error: parsed.error.message,
      legacy_path: legacyPath,
    });
    return false;
  }

  const now = new Date().toISOString();
  const migratedEntries = parsed.data.map((task) => {
    const trigger = { type: "cron" as const, expression: task.cron, timezone: "UTC" };
    return ScheduleEntrySchema.parse({
      id: randomUUID(),
      name: `Legacy ${task.type}: ${task.prompt.slice(0, 48)}`.trim(),
      layer: "cron",
      trigger,
      enabled: task.enabled,
      metadata: {
        source: "manual" as const,
        dependency_hints: [],
        note: `Migrated from legacy CronScheduler task ${task.id} (${task.type})`,
      },
      cron: {
        job_kind: "prompt",
        prompt_template: task.prompt,
        context_sources: [],
        output_format: "notification",
        report_type: `legacy_${task.type}`,
        max_tokens: 4000,
      },
      baseline_results: [],
      created_at: task.created_at,
      updated_at: now,
      last_fired_at: task.last_fired_at,
      next_fire_at: computeNextFireAt(trigger),
      consecutive_failures: 0,
      last_escalation_at: null,
      escalation_timestamps: [],
      total_executions: 0,
      total_tokens_used: 0,
      max_tokens_per_day: 100000,
      tokens_used_today: 0,
      budget_reset_at: null,
    });
  });

  await writeJsonFileAtomic(schedulesPath, migratedEntries);
  await fsp.rm(archivePath, { force: true }).catch(() => undefined);
  await fsp.rename(legacyPath, archivePath);
  params.logger.info?.("Migrated legacy CronScheduler tasks into ScheduleEngine entries", {
    migrated_count: migratedEntries.length,
    legacy_path: legacyPath,
    archive_path: archivePath,
    schedules_path: schedulesPath,
  });
  return true;
}
