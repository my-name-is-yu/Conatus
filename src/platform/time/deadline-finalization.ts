import type {
  Goal,
  GoalFinalizationExternalAction,
  GoalFinalizationPolicy,
} from "../../base/types/goal.js";

export type DeadlineFinalizationMode =
  | "no_deadline"
  | "exploration"
  | "consolidation"
  | "finalization"
  | "missed_deadline";

export interface DeadlineFinalizationArtifact {
  id?: string;
  label: string;
  kind?: string;
  summary?: string;
  path?: string;
  state_relative_path?: string;
  url?: string;
  occurred_at?: string;
  source: "runtime_evidence_ledger" | "policy" | "none";
}

export interface DeadlineFinalizationAction {
  id: string;
  label: string;
  tool_name?: string;
  payload_ref?: string;
  approval_required: true;
}

export interface DeadlineFinalizationPlan {
  deliverable_contract: string | null;
  best_artifact_selection: GoalFinalizationPolicy["best_artifact_selection"];
  best_artifact: DeadlineFinalizationArtifact | null;
  reproducibility_manifest: DeadlineReproducibilityManifestPreflight;
  verification_steps: string[];
  approval_required_actions: DeadlineFinalizationAction[];
  handoff_required: boolean;
}

export interface DeadlineReproducibilityManifestPreflight {
  required: boolean;
  status: "not_required" | "required_missing" | "ready";
  manifest_id?: string;
  reason: string;
}

export interface DeadlineFinalizationStatus {
  mode: DeadlineFinalizationMode;
  deadline: string | null;
  evaluated_at: string;
  remaining_ms: number | null;
  reserved_finalization_ms: number;
  remaining_exploration_ms: number | null;
  consolidation_buffer_ms: number;
  finalization_plan: DeadlineFinalizationPlan | null;
  reason: string;
}

export interface BuildDeadlineFinalizationStatusInput {
  goal: Goal;
  now?: Date;
  bestArtifact?: DeadlineFinalizationArtifact | null;
  reproducibilityManifestId?: string | null;
}

export const DEFAULT_FINALIZATION_POLICY: GoalFinalizationPolicy = {
  minimum_buffer_ms: 30 * 60 * 1000,
  consolidation_buffer_ms: 0,
  best_artifact_selection: "best_evidence",
  require_reproducibility_manifest: false,
  verification_steps: [],
  external_actions: [],
};

export function normalizeFinalizationPolicy(
  policy: Goal["finalization_policy"] | null | undefined
): GoalFinalizationPolicy {
  return {
    ...DEFAULT_FINALIZATION_POLICY,
    ...(policy ?? {}),
    external_actions: (policy?.external_actions ?? []).map(normalizeExternalAction),
    verification_steps: [...(policy?.verification_steps ?? DEFAULT_FINALIZATION_POLICY.verification_steps)],
  };
}

export function buildDeadlineFinalizationStatus(
  input: BuildDeadlineFinalizationStatusInput
): DeadlineFinalizationStatus {
  const now = input.now ?? new Date();
  const evaluatedAt = now.toISOString();
  const deadline = input.goal.deadline ?? null;
  const policy = normalizeFinalizationPolicy(input.goal.finalization_policy);

  if (!deadline) {
    return {
      mode: "no_deadline",
      deadline: null,
      evaluated_at: evaluatedAt,
      remaining_ms: null,
      reserved_finalization_ms: policy.minimum_buffer_ms,
      remaining_exploration_ms: null,
      consolidation_buffer_ms: policy.consolidation_buffer_ms,
      finalization_plan: null,
      reason: "Goal has no deadline.",
    };
  }

  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(deadlineMs)) {
    return {
      mode: "no_deadline",
      deadline,
      evaluated_at: evaluatedAt,
      remaining_ms: null,
      reserved_finalization_ms: policy.minimum_buffer_ms,
      remaining_exploration_ms: null,
      consolidation_buffer_ms: policy.consolidation_buffer_ms,
      finalization_plan: null,
      reason: "Goal deadline is not parseable.",
    };
  }

  const remainingMs = deadlineMs - now.getTime();
  const remainingExplorationMs = Math.max(0, remainingMs - policy.minimum_buffer_ms);
  const mode = classifyFinalizationMode(remainingMs, policy);

  return {
    mode,
    deadline,
    evaluated_at: evaluatedAt,
    remaining_ms: remainingMs,
    reserved_finalization_ms: policy.minimum_buffer_ms,
    remaining_exploration_ms: remainingExplorationMs,
    consolidation_buffer_ms: policy.consolidation_buffer_ms,
    finalization_plan: buildFinalizationPlan(policy, input.bestArtifact ?? null, input.reproducibilityManifestId ?? null),
    reason: buildReason(mode, remainingMs, policy),
  };
}

export function shouldStopExplorationForFinalization(status: DeadlineFinalizationStatus): boolean {
  return status.mode === "finalization" || status.mode === "missed_deadline";
}

function classifyFinalizationMode(
  remainingMs: number,
  policy: GoalFinalizationPolicy
): DeadlineFinalizationMode {
  if (remainingMs <= 0) return "missed_deadline";
  if (remainingMs <= policy.minimum_buffer_ms) return "finalization";
  if (remainingMs <= policy.minimum_buffer_ms + policy.consolidation_buffer_ms) {
    return "consolidation";
  }
  return "exploration";
}

function buildFinalizationPlan(
  policy: GoalFinalizationPolicy,
  bestArtifact: DeadlineFinalizationArtifact | null,
  reproducibilityManifestId: string | null
): DeadlineFinalizationPlan {
  const approvalActions = policy.external_actions.map((action) => ({
    id: action.id,
    label: action.label,
    ...(action.tool_name ? { tool_name: action.tool_name } : {}),
    ...(action.payload_ref ? { payload_ref: action.payload_ref } : {}),
    approval_required: true as const,
  }));

  const reproducibilityManifest = buildReproducibilityManifestPreflight(policy, reproducibilityManifestId);
  return {
    deliverable_contract: policy.deliverable_contract ?? null,
    best_artifact_selection: policy.best_artifact_selection,
    best_artifact: bestArtifact,
    reproducibility_manifest: reproducibilityManifest,
    verification_steps: [...policy.verification_steps],
    approval_required_actions: approvalActions,
    handoff_required: approvalActions.length > 0 || reproducibilityManifest.status === "required_missing",
  };
}

function buildReproducibilityManifestPreflight(
  policy: GoalFinalizationPolicy,
  manifestId: string | null
): DeadlineReproducibilityManifestPreflight {
  if (!policy.require_reproducibility_manifest) {
    return {
      required: false,
      status: "not_required",
      reason: "Reproducibility manifest is not required by this finalization policy.",
    };
  }
  if (manifestId) {
    return {
      required: true,
      status: "ready",
      manifest_id: manifestId,
      reason: "Reproducibility manifest is ready before delivery/submission.",
    };
  }
  return {
    required: true,
    status: "required_missing",
    reason: "Reproducibility manifest is required before delivery/submission.",
  };
}

function normalizeExternalAction(
  action: GoalFinalizationExternalAction
): GoalFinalizationExternalAction {
  return {
    ...action,
    approval_required: true,
  };
}

function buildReason(
  mode: DeadlineFinalizationMode,
  remainingMs: number,
  policy: GoalFinalizationPolicy
): string {
  if (mode === "missed_deadline") {
    return "Deadline has passed; preserve the best artifact and prepare operator handoff.";
  }
  if (mode === "finalization") {
    return `Remaining time is inside the reserved finalization buffer (${policy.minimum_buffer_ms}ms).`;
  }
  if (mode === "consolidation") {
    return `Remaining time is inside the consolidation window (${policy.minimum_buffer_ms + policy.consolidation_buffer_ms}ms).`;
  }
  return `Exploration may continue with ${Math.max(0, remainingMs - policy.minimum_buffer_ms)}ms before the reserved finalization buffer.`;
}
