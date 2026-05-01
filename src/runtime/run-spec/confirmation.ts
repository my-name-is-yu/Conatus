import type { RunSpec, RunSpecDeadline, RunSpecMissingField } from "./types.js";
import { RunSpecSchema } from "./types.js";

export type RunSpecConfirmationResult =
  | { kind: "confirmed"; spec: RunSpec; message: string }
  | { kind: "cancelled"; spec: RunSpec; message: string }
  | { kind: "revised"; spec: RunSpec; message: string }
  | { kind: "blocked"; spec: RunSpec; message: string }
  | { kind: "unrecognized"; spec: RunSpec; message: string };

export interface RunSpecConfirmationContext {
  now?: Date;
  timezone?: string;
}

export function formatRunSpecSetupProposal(spec: RunSpec): string {
  const lines = [
    `Proposed long-running run: ${spec.id}`,
    `Profile: ${spec.profile}`,
    `Objective: ${spec.objective}`,
    `Workspace: ${spec.workspace?.path ?? "unresolved"}`,
    `Execution: ${spec.execution_target.kind}${spec.execution_target.remote_host ? ` (${spec.execution_target.remote_host})` : ""}`,
    `Progress: ${spec.progress_contract.semantics}`,
  ];
  if (spec.metric) {
    lines.push(`Metric: ${spec.metric.name} (${spec.metric.direction})`);
  }
  if (spec.deadline) {
    lines.push(`Deadline: ${spec.deadline.raw}${spec.deadline.iso_at ? ` (${spec.deadline.iso_at})` : ""}`);
  }
  lines.push(`Submit policy: ${spec.approval_policy.submit}`);
  lines.push(`Publish policy: ${spec.approval_policy.publish}`);
  lines.push(`External actions: ${spec.approval_policy.external_action}`);
  lines.push(`Secret policy: ${spec.approval_policy.secret}`);
  lines.push(`Irreversible actions: ${spec.approval_policy.irreversible_action}`);
  if (spec.missing_fields.length > 0) {
    lines.push("Questions:", ...spec.missing_fields.map((field) => `- ${field.question}`));
  }
  return lines.join("\n");
}

export function handleRunSpecConfirmationInput(
  spec: RunSpec,
  input: string,
  context: RunSpecConfirmationContext = {},
): RunSpecConfirmationResult {
  const trimmed = input.trim();
  const now = context.now ?? new Date();

  if (/^(cancel|abort|stop|やめる|キャンセル)$/i.test(trimmed)) {
    const cancelled = updateSpec(spec, { status: "cancelled", updated_at: now.toISOString() });
    return { kind: "cancelled", spec: cancelled, message: `RunSpec cancelled: ${cancelled.id}` };
  }

  if (/^(confirm|start|start run|approve|ok|yes|開始|承認)$/i.test(trimmed)) {
    const required = requiredMissingFields(spec);
    if (required.length > 0) {
      return {
        kind: "blocked",
        spec,
        message: formatMissingFieldsMessage(required),
      };
    }
    const confirmed = updateSpec(spec, { status: "confirmed", updated_at: now.toISOString() });
    return { kind: "confirmed", spec: confirmed, message: `RunSpec confirmed: ${confirmed.id}` };
  }

  const revised = applyRunSpecRevision(spec, trimmed, {
    now,
    timezone: context.timezone,
  });
  if (revised) {
    return {
      kind: "revised",
      spec: revised,
      message: formatRunSpecSetupProposal(revised),
    };
  }

  return {
    kind: "unrecognized",
    spec,
    message: [
      "RunSpec is awaiting confirmation.",
      "Use confirm, cancel, or revise with a workspace, deadline, or metric direction.",
      formatMissingFieldsMessage(requiredMissingFields(spec)),
    ].filter(Boolean).join("\n"),
  };
}

export function requiredMissingFields(spec: RunSpec): RunSpecMissingField[] {
  return spec.missing_fields.filter((field) => field.severity === "required");
}

export function applyRunSpecRevision(
  spec: RunSpec,
  input: string,
  context: RunSpecConfirmationContext = {},
): RunSpec | null {
  const now = context.now ?? new Date();
  const updates: Partial<RunSpec> = {
    updated_at: now.toISOString(),
  };
  let changed = false;
  let missingFields = [...spec.missing_fields];

  const workspace = parseWorkspace(input);
  if (workspace) {
    updates.workspace = {
      path: workspace,
      source: "user",
      confidence: "high",
    };
    missingFields = removeMissing(missingFields, "workspace");
    changed = true;
  }

  const deadline = parseDeadline(input, now, context.timezone);
  if (deadline) {
    updates.deadline = deadline;
    updates.budget = {
      ...spec.budget,
      max_wall_clock_minutes: deadline.iso_at ? minutesUntil(now, new Date(deadline.iso_at)) : spec.budget.max_wall_clock_minutes,
      resident_policy: "until_deadline",
    };
    missingFields = removeMissing(missingFields, "deadline");
    changed = true;
  }

  const metricDirection = parseMetricDirection(input);
  if (metricDirection && spec.metric) {
    updates.metric = {
      ...spec.metric,
      direction: metricDirection,
      confidence: "high",
    };
    missingFields = removeMissing(missingFields, "metric.direction");
    changed = true;
  }

  if (!changed) return null;
  return updateSpec(spec, {
    ...updates,
    missing_fields: missingFields,
  });
}

function updateSpec(spec: RunSpec, updates: Partial<RunSpec>): RunSpec {
  return RunSpecSchema.parse({
    ...spec,
    ...updates,
  });
}

function removeMissing(fields: RunSpecMissingField[], field: string): RunSpecMissingField[] {
  return fields.filter((entry) => entry.field !== field);
}

function parseWorkspace(input: string): string | null {
  return input.match(/(?:workspace|cwd|directory|dir|repo|path)\s+((?:~|\/)[^\s,]+)/i)?.[1]
    ?? input.match(/(?:ワークスペース|ディレクトリ|リポジトリ)\s*((?:~|\/)[^\s,]+)/i)?.[1]
    ?? null;
}

function parseMetricDirection(input: string): "maximize" | "minimize" | null {
  if (/\b(maximi[sz]e|higher|increase)\b|最大|上げ|高く/i.test(input)) return "maximize";
  if (/\b(minimi[sz]e|lower|decrease|reduce)\b|最小|下げ|低く/i.test(input)) return "minimize";
  return null;
}

function parseDeadline(input: string, now: Date, timezone: string | undefined): RunSpecDeadline | null {
  const lower = input.toLowerCase();
  if (lower.includes("tomorrow morning") || /明日.*(朝|午前)/.test(input)) {
    const at = new Date(now);
    at.setDate(at.getDate() + 1);
    at.setHours(9, 0, 0, 0);
    return {
      raw: lower.includes("tomorrow morning") ? "tomorrow morning" : "明日朝",
      iso_at: at.toISOString(),
      timezone: timezone ?? null,
      finalization_buffer_minutes: 60,
      confidence: "medium",
    };
  }
  const hoursMatch = input.match(/\b(?:for|within|deadline)\s+(\d+)\s*(hours?|hrs?)\b/i);
  if (!hoursMatch) return null;
  const at = new Date(now.getTime() + Number(hoursMatch[1]) * 60 * 60 * 1000);
  return {
    raw: hoursMatch[0],
    iso_at: at.toISOString(),
    timezone: timezone ?? null,
    finalization_buffer_minutes: 30,
    confidence: "medium",
  };
}

function formatMissingFieldsMessage(fields: RunSpecMissingField[]): string {
  if (fields.length === 0) return "";
  return [
    "Run cannot start until required fields are resolved:",
    ...fields.map((field) => `- ${field.question}`),
  ].join("\n");
}

function minutesUntil(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
}
