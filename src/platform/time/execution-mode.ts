import type { DeadlineFinalizationStatus } from "./deadline-finalization.js";

export type ExecutionMode = "exploration" | "consolidation" | "finalization";

export type ExecutionModeTransitionSource =
  | "default"
  | "deadline_finalization"
  | "operator"
  | "dream";

export interface ExecutionModeState {
  mode: ExecutionMode;
  source: ExecutionModeTransitionSource;
  reason: string;
  changed_at: string;
  finalization_mode?: DeadlineFinalizationStatus["mode"];
  approval_required_to_explore?: boolean;
}

export interface GeneratedTaskForModeCheck {
  work_description: string;
  rationale?: string;
  approach?: string;
  scope_boundary?: {
    in_scope?: string[];
    out_of_scope?: string[];
    blast_radius?: string;
  };
  constraints?: string[];
}

export function deriveExecutionModeFromDeadlineStatus(
  status: DeadlineFinalizationStatus
): ExecutionModeState {
  const base = {
    source: "deadline_finalization" as const,
    reason: status.reason,
    changed_at: status.evaluated_at,
    finalization_mode: status.mode,
  };

  if (status.mode === "consolidation") {
    return { ...base, mode: "consolidation" };
  }

  if (status.mode === "finalization" || status.mode === "missed_deadline") {
    return {
      ...base,
      mode: "finalization",
      approval_required_to_explore: true,
    };
  }

  return {
    ...base,
    mode: "exploration",
  };
}

export function formatExecutionModePromptSection(
  executionMode: ExecutionModeState | undefined
): string {
  if (!executionMode) return "";

  const header = [
    "",
    "=== Current Execution Mode ===",
    `Mode: ${executionMode.mode}`,
    `Reason: ${executionMode.reason}`,
  ];

  if (executionMode.mode === "exploration") {
    return [
      ...header,
      "Allowed task categories: new hypotheses, new experiments, evidence gathering, and implementation tasks that open a plausible path toward the goal.",
      "Keep scope bounded and verifiable.",
      "",
    ].join("\n");
  }

  if (executionMode.mode === "consolidation") {
    return [
      ...header,
      "Allowed task categories: stabilize existing candidates, rerun selected validations, compare evidence, reduce uncertainty, and prepare candidate handoff material.",
      "Avoid opening a new speculative experiment family unless the operator has already approved that return to broad exploration.",
      "",
    ].join("\n");
  }

  return [
    ...header,
    "Allowed task categories: artifact verification, packaging, candidate selection from existing evidence, final report preparation, and operator handoff.",
    "Blocked by default: new speculative experiments, new candidate families, broad exploration branches, and infrastructure created only to search for more candidates.",
    "Returning to broad exploration requires explicit operator approval.",
    "",
  ].join("\n");
}

export function isExploratoryGeneratedTask(task: GeneratedTaskForModeCheck): boolean {
  const text = [
    task.work_description,
    task.rationale,
    task.approach,
    ...(task.scope_boundary?.in_scope ?? []),
    ...(task.scope_boundary?.out_of_scope ?? []),
    task.scope_boundary?.blast_radius,
    ...(task.constraints ?? []),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();

  return [
    /\bexplor(e|ation|atory)\b/,
    /\b(new|novel|additional)\s+(hypothes(is|es)|experiment|candidate|model|feature|branch|lineage|approach|pipeline|infrastructure)\b/,
    /\btry\s+(a|another|new|multiple)\b/,
    /\bprototype\b/,
    /\bexperiment\s+(bank|family|runner|backfill)\b/,
  ].some((pattern) => pattern.test(text));
}

export function isGeneratedTaskAllowedForExecutionMode(
  task: GeneratedTaskForModeCheck,
  executionMode: ExecutionModeState | undefined,
  options: { explorationApproved?: boolean } = {}
): boolean {
  if (!executionMode || executionMode.mode !== "finalization") return true;
  if (options.explorationApproved) return true;
  return !isExploratoryGeneratedTask(task);
}
