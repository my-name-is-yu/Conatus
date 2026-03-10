import { z } from "zod";
import { ReportTypeEnum, VerbosityLevelEnum } from "./core.js";

// --- Report ---

export const ReportSchema = z.object({
  id: z.string(),
  report_type: ReportTypeEnum,
  goal_id: z.string().nullable().default(null),
  title: z.string(),
  content: z.string(),
  verbosity: VerbosityLevelEnum.default("standard"),
  generated_at: z.string(),
  delivered_at: z.string().nullable().default(null),
  read: z.boolean().default(false),
});
export type Report = z.infer<typeof ReportSchema>;

// --- Reporting Schedule ---

export const ReportingScheduleSchema = z.object({
  daily_summary: z.object({
    enabled: z.boolean().default(true),
    time: z.string().default("09:00"),
    timezone: z.string().default("UTC"),
    skip_if_no_activity: z.boolean().default(true),
  }),
  weekly_report: z.object({
    enabled: z.boolean().default(true),
    day: z.string().default("monday"),
    time: z.string().default("09:00"),
    timezone: z.string().default("UTC"),
    skip_if_no_activity: z.boolean().default(false),
  }),
});
export type ReportingSchedule = z.infer<typeof ReportingScheduleSchema>;
