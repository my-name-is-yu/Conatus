import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ResidentActivitySchema } from "../../base/types/daemon.js";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";

export const ProactiveInterventionOutcomeSchema = z.enum([
  "accepted",
  "ignored",
  "dismissed",
  "corrected",
  "overreach",
]);

export const ProactiveOverreachIndicatorSchema = z.enum([
  "too_frequent",
  "wrong_context",
  "sensitive",
  "unwanted_timing",
]);

const ProactiveInterventionBaseEventSchema = z.object({
  schema_version: z.literal("runtime-proactive-intervention-event-v1"),
  event_id: z.string().min(1),
  intervention_id: z.string().min(1),
  recorded_at: z.string().datetime(),
  channel: z.enum(["daemon", "cli", "gateway"]).default("daemon"),
});

export const ProactiveInterventionActivityEventSchema = ProactiveInterventionBaseEventSchema.extend({
  event_type: z.literal("intervention"),
  activity: ResidentActivitySchema,
});

export const ProactiveInterventionFeedbackEventSchema = ProactiveInterventionBaseEventSchema.extend({
  event_type: z.literal("feedback"),
  outcome: ProactiveInterventionOutcomeSchema,
  reason: z.string().optional(),
  overreach_indicators: z.array(ProactiveOverreachIndicatorSchema).default([]),
  follow_through_success: z.boolean().nullable().default(null),
  policy_adjustment_recommendation: z.object({
    relationship_profile_key: z.string().min(1),
    suggested_action: z.enum(["reduce_frequency", "require_confirmation", "narrow_scope", "avoid_sensitive_context"]),
    reason: z.string().min(1),
  }).nullable().default(null),
});

export const ProactiveInterventionEventSchema = z.discriminatedUnion("event_type", [
  ProactiveInterventionActivityEventSchema,
  ProactiveInterventionFeedbackEventSchema,
]);

export const ProactiveInterventionSummarySchema = z.object({
  total_interventions: z.number().int().nonnegative(),
  pending_count: z.number().int().nonnegative(),
  response_count: z.number().int().nonnegative(),
  accepted_count: z.number().int().nonnegative(),
  ignored_count: z.number().int().nonnegative(),
  dismissed_count: z.number().int().nonnegative(),
  corrected_count: z.number().int().nonnegative(),
  overreach_count: z.number().int().nonnegative(),
  response_rate: z.number().min(0).max(1).nullable(),
  accepted_rate: z.number().min(0).max(1).nullable(),
  ignored_rate: z.number().min(0).max(1).nullable(),
  correction_rate: z.number().min(0).max(1).nullable(),
  overreach_rate: z.number().min(0).max(1).nullable(),
  average_time_to_response_ms: z.number().nonnegative().nullable(),
  by_kind: z.record(z.number().int().nonnegative()),
  by_channel: z.record(z.number().int().nonnegative()),
  latest_feedback_at: z.string().datetime().nullable(),
  policy_adjustment_recommendation: z.object({
    relationship_profile_key: z.string().min(1),
    suggested_action: z.enum(["reduce_frequency", "require_confirmation", "narrow_scope", "avoid_sensitive_context"]),
    reason: z.string().min(1),
  }).nullable(),
});

export type ProactiveInterventionOutcome = z.infer<typeof ProactiveInterventionOutcomeSchema>;
export type ProactiveOverreachIndicator = z.infer<typeof ProactiveOverreachIndicatorSchema>;
export type ProactiveInterventionActivityEvent = z.infer<typeof ProactiveInterventionActivityEventSchema>;
export type ProactiveInterventionFeedbackEvent = z.infer<typeof ProactiveInterventionFeedbackEventSchema>;
export type ProactiveInterventionEvent = z.infer<typeof ProactiveInterventionEventSchema>;
export type ProactiveInterventionSummary = z.infer<typeof ProactiveInterventionSummarySchema>;

export interface ProactiveFeedbackInput {
  interventionId: string;
  outcome: ProactiveInterventionOutcome;
  reason?: string;
  overreachIndicators?: ProactiveOverreachIndicator[];
  followThroughSuccess?: boolean | null;
  channel?: "daemon" | "cli" | "gateway";
  recordedAt?: string;
}

function eventId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function countRate(count: number, total: number): number | null {
  return total > 0 ? count / total : null;
}

function recommendationForFeedback(input: {
  outcome: ProactiveInterventionOutcome;
  overreachIndicators: ProactiveOverreachIndicator[];
  reason?: string;
}): ProactiveInterventionFeedbackEvent["policy_adjustment_recommendation"] {
  if (input.outcome === "overreach") {
    const suggestedAction = input.overreachIndicators.includes("sensitive")
      ? "avoid_sensitive_context"
      : input.overreachIndicators.includes("too_frequent")
        ? "reduce_frequency"
        : input.overreachIndicators.includes("wrong_context")
          ? "narrow_scope"
          : "require_confirmation";
    return {
      relationship_profile_key: "user.intervention.proactivity",
      suggested_action: suggestedAction,
      reason: input.reason ?? `User marked proactive intervention as overreach (${input.overreachIndicators.join(", ") || "unspecified"}).`,
    };
  }
  if (input.outcome === "corrected") {
    return {
      relationship_profile_key: "user.intervention.correction_policy",
      suggested_action: "require_confirmation",
      reason: input.reason ?? "User corrected a proactive intervention.",
    };
  }
  return null;
}

export class ProactiveInterventionStore {
  private readonly paths: RuntimeStorePaths;

  constructor(runtimeRootOrPaths?: string | RuntimeStorePaths) {
    this.paths =
      typeof runtimeRootOrPaths === "string"
        ? createRuntimeStorePaths(runtimeRootOrPaths)
        : runtimeRootOrPaths ?? createRuntimeStorePaths();
  }

  async ensureReady(): Promise<void> {
    await fsp.mkdir(this.paths.proactiveInterventionsDir, { recursive: true });
  }

  async appendIntervention(input: {
    activity: z.infer<typeof ResidentActivitySchema>;
    channel?: "daemon" | "cli" | "gateway";
  }): Promise<ProactiveInterventionActivityEvent> {
    const activity = ResidentActivitySchema.parse(input.activity);
    const interventionId = activity.intervention_id ?? eventId("proactive-intervention");
    const event = ProactiveInterventionActivityEventSchema.parse({
      schema_version: "runtime-proactive-intervention-event-v1",
      event_id: eventId("proactive-event"),
      intervention_id: interventionId,
      recorded_at: activity.recorded_at,
      channel: input.channel ?? "daemon",
      event_type: "intervention",
      activity: {
        ...activity,
        intervention_id: interventionId,
      },
    });
    return this.append(event);
  }

  async appendFeedback(input: ProactiveFeedbackInput): Promise<ProactiveInterventionFeedbackEvent> {
    const overreachIndicators = input.overreachIndicators ?? [];
    const event = ProactiveInterventionFeedbackEventSchema.parse({
      schema_version: "runtime-proactive-intervention-event-v1",
      event_id: eventId("proactive-event"),
      intervention_id: input.interventionId,
      recorded_at: input.recordedAt ?? new Date().toISOString(),
      channel: input.channel ?? "cli",
      event_type: "feedback",
      outcome: input.outcome,
      reason: input.reason,
      overreach_indicators: overreachIndicators,
      follow_through_success: input.followThroughSuccess ?? null,
      policy_adjustment_recommendation: recommendationForFeedback({
        outcome: input.outcome,
        overreachIndicators,
        reason: input.reason,
      }),
    });
    return this.append(event);
  }

  async append<T extends ProactiveInterventionEvent>(event: T): Promise<T> {
    const parsed = ProactiveInterventionEventSchema.parse(event) as T;
    await this.ensureReady();
    await fsp.appendFile(this.paths.proactiveInterventionLedgerPath, `${JSON.stringify(parsed)}\n`, "utf8");
    return parsed;
  }

  async list(limit?: number): Promise<ProactiveInterventionEvent[]> {
    const raw = await fsp.readFile(this.paths.proactiveInterventionLedgerPath, "utf8").catch(() => "");
    if (!raw.trim()) return [];
    const events: ProactiveInterventionEvent[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        events.push(ProactiveInterventionEventSchema.parse(JSON.parse(line)));
      } catch {
        // Malformed history should not block operational health surfaces.
      }
    }
    const effectiveLimit = limit ?? events.length;
    return events.slice(Math.max(0, events.length - effectiveLimit));
  }

  async summarize(): Promise<ProactiveInterventionSummary> {
    return summarizeProactiveInterventions(await this.list());
  }
}

export function summarizeProactiveInterventions(events: ProactiveInterventionEvent[]): ProactiveInterventionSummary {
  const interventions = events.filter((event): event is ProactiveInterventionActivityEvent => event.event_type === "intervention");
  const feedbacks = events.filter((event): event is ProactiveInterventionFeedbackEvent => event.event_type === "feedback");
  const byKind: Record<string, number> = {};
  const byChannel: Record<string, number> = {};
  const interventionsById = new Map(interventions.map((event) => [event.intervention_id, event]));
  const feedbackByIntervention = new Map<string, ProactiveInterventionFeedbackEvent>();
  let accepted = 0;
  let ignored = 0;
  let dismissed = 0;
  let corrected = 0;
  let overreach = 0;
  let latestFeedbackAt: string | null = null;
  let responseTimeTotal = 0;
  let responseTimeCount = 0;
  let latestRecommendation: ProactiveInterventionFeedbackEvent["policy_adjustment_recommendation"] = null;

  for (const intervention of interventions) {
    byKind[intervention.activity.kind] = (byKind[intervention.activity.kind] ?? 0) + 1;
    byChannel[intervention.channel] = (byChannel[intervention.channel] ?? 0) + 1;
  }

  for (const feedback of feedbacks) {
    const existing = feedbackByIntervention.get(feedback.intervention_id);
    if (!existing || feedback.recorded_at >= existing.recorded_at) {
      feedbackByIntervention.set(feedback.intervention_id, feedback);
    }
    if (latestFeedbackAt === null || feedback.recorded_at > latestFeedbackAt) {
      latestFeedbackAt = feedback.recorded_at;
    }
    if (feedback.policy_adjustment_recommendation) {
      latestRecommendation = feedback.policy_adjustment_recommendation;
    }
  }

  for (const [interventionId, feedback] of feedbackByIntervention) {
    const intervention = interventionsById.get(interventionId);
    if (!intervention) continue;
    if (feedback.outcome === "accepted") accepted += 1;
    if (feedback.outcome === "ignored") ignored += 1;
    if (feedback.outcome === "dismissed") dismissed += 1;
    if (feedback.outcome === "corrected") corrected += 1;
    if (feedback.outcome === "overreach") overreach += 1;
    const delta = new Date(feedback.recorded_at).getTime() - new Date(intervention.recorded_at).getTime();
    if (Number.isFinite(delta) && delta >= 0) {
      responseTimeTotal += delta;
      responseTimeCount += 1;
    }
  }

  const total = interventions.length;
  const responseCount = [...feedbackByIntervention.keys()].filter((interventionId) => interventionsById.has(interventionId)).length;
  return ProactiveInterventionSummarySchema.parse({
    total_interventions: total,
    pending_count: Math.max(0, total - responseCount),
    response_count: responseCount,
    accepted_count: accepted,
    ignored_count: ignored,
    dismissed_count: dismissed,
    corrected_count: corrected,
    overreach_count: overreach,
    response_rate: countRate(responseCount, total),
    accepted_rate: countRate(accepted, total),
    ignored_rate: countRate(ignored, total),
    correction_rate: countRate(corrected, total),
    overreach_rate: countRate(overreach, total),
    average_time_to_response_ms: responseTimeCount > 0 ? responseTimeTotal / responseTimeCount : null,
    by_kind: byKind,
    by_channel: byChannel,
    latest_feedback_at: latestFeedbackAt,
    policy_adjustment_recommendation: latestRecommendation,
  });
}
