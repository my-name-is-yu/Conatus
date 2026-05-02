import {
  classifyConfirmationDecision,
  type ConfirmationDecision,
} from "../confirmation-decision.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { RunSpec, RunSpecMissingField } from "./types.js";
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
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">;
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

export async function handleRunSpecConfirmationInput(
  spec: RunSpec,
  input: string,
  context: RunSpecConfirmationContext = {},
): Promise<RunSpecConfirmationResult> {
  const now = context.now ?? new Date();
  const decision = await classifyConfirmationDecision(input, {
    kind: "run_spec_confirmation",
    llmClient: context.llmClient,
    allowedDecisions: ["approve", "cancel", "revise", "unknown"],
    subject: formatRunSpecConfirmationContext(spec),
  });

  if (decision.decision === "cancel") {
    const cancelled = updateSpec(spec, { status: "cancelled", updated_at: now.toISOString() });
    return { kind: "cancelled", spec: cancelled, message: `RunSpec cancelled: ${cancelled.id}` };
  }

  if (decision.decision === "approve") {
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

  if (decision.decision === "revise") {
    const revised = applyRunSpecRevision(spec, decision, {
      now,
      timezone: context.timezone,
    });
    if (!revised) {
      return {
        kind: "unrecognized",
        spec,
        message: [
          "RunSpec revision needs structured workspace, deadline, or metric direction details.",
          formatMissingFieldsMessage(requiredMissingFields(spec)),
        ].filter(Boolean).join("\n"),
      };
    }
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
      decision.clarification ?? "Please approve, cancel, or revise the pending RunSpec.",
      formatMissingFieldsMessage(requiredMissingFields(spec)),
    ].filter(Boolean).join("\n"),
  };
}

export function requiredMissingFields(spec: RunSpec): RunSpecMissingField[] {
  return spec.missing_fields.filter((field) => field.severity === "required");
}

export function applyRunSpecRevision(
  spec: RunSpec,
  decision: ConfirmationDecision,
  context: RunSpecConfirmationContext = {},
): RunSpec | null {
  const now = context.now ?? new Date();
  const revision = decision.revision;
  if (!revision) return null;
  const updates: Partial<RunSpec> = {
    updated_at: now.toISOString(),
  };
  let changed = false;
  let missingFields = [...spec.missing_fields];

  if (revision.workspace_path) {
    updates.workspace = {
      path: revision.workspace_path,
      source: "user",
      confidence: "high",
    };
    missingFields = removeMissing(missingFields, "workspace");
    changed = true;
  }

  if (revision.deadline) {
    updates.deadline = {
      raw: revision.deadline.raw,
      iso_at: revision.deadline.iso_at ?? null,
      timezone: revision.deadline.timezone ?? context.timezone ?? null,
      finalization_buffer_minutes: revision.deadline.finalization_buffer_minutes ?? null,
      confidence: revision.deadline.confidence ?? "medium",
    };
    updates.budget = {
      ...spec.budget,
      max_wall_clock_minutes: updates.deadline.iso_at ? minutesUntil(now, new Date(updates.deadline.iso_at)) : spec.budget.max_wall_clock_minutes,
      resident_policy: "until_deadline",
    };
    missingFields = removeMissing(missingFields, "deadline");
    changed = true;
  }

  if (revision.metric_direction && spec.metric) {
    updates.metric = {
      ...spec.metric,
      direction: revision.metric_direction,
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

function formatRunSpecConfirmationContext(spec: RunSpec): string {
  const required = requiredMissingFields(spec);
  return [
    `RunSpec ID: ${spec.id}`,
    `Status: ${spec.status}`,
    `Profile: ${spec.profile}`,
    `Objective: ${spec.objective}`,
    `Workspace: ${spec.workspace?.path ?? "unresolved"}`,
    `Deadline: ${spec.deadline?.raw ?? "unresolved"}`,
    `Metric: ${spec.metric ? `${spec.metric.name} (${spec.metric.direction})` : "unresolved"}`,
    `Progress: ${spec.progress_contract.semantics}`,
    `Submit policy: ${spec.approval_policy.submit}`,
    `Publish policy: ${spec.approval_policy.publish}`,
    `External actions: ${spec.approval_policy.external_action}`,
    `Secret policy: ${spec.approval_policy.secret}`,
    `Irreversible actions: ${spec.approval_policy.irreversible_action}`,
    required.length > 0 ? `Required missing fields: ${required.map((field) => field.field).join(", ")}` : "Required missing fields: none",
  ].join("\n");
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
