import type { Goal } from "../../../base/types/goal.js";
import type { DriveScore } from "../../../base/types/drive.js";
import type { DeadlineFinalizationStatus } from "../../../platform/time/deadline-finalization.js";
import type { MetricTrendContext } from "../../../platform/drive/metric-history.js";
import type { RuntimeDreamCheckpointContext } from "../../../runtime/store/dream-checkpoints.js";
import type { RuntimeEvidenceEntry, RuntimeEvidenceSummary } from "../../../runtime/store/evidence-ledger.js";
import type {
  DreamReviewCheckpointEvidence,
  DreamReviewCheckpointTrigger,
} from "./phase-specs.js";
import type { LoopIterationResult } from "../loop-result-types.js";

export interface DreamReviewCheckpointRequest {
  trigger: DreamReviewCheckpointTrigger;
  reason: string;
  activeDimensions: string[];
  bestEvidenceSummary?: string;
  recentStrategyFamilies: string[];
  metricTrendSummary?: string;
  finalizationReason?: string;
  memoryAuthorityPolicy: "soil_and_playbooks_are_advisory_only";
  maxGuidanceItems: number;
}

export interface DreamReviewCheckpointTriggerOptions {
  iterationInterval?: number;
  minIterationsBetween?: number;
}

export interface BuildDreamReviewCheckpointRequestInput {
  goal: Goal;
  loopIndex: number;
  result: LoopIterationResult;
  driveScores: DriveScore[];
  finalizationStatus?: DeadlineFinalizationStatus;
  recentCheckpoints?: RuntimeDreamCheckpointContext[];
  evidenceSummary?: Pick<RuntimeEvidenceSummary, "best_evidence" | "recent_entries"> | null;
  requestedTrigger?: DreamReviewCheckpointTrigger;
  options?: DreamReviewCheckpointTriggerOptions;
}

const DEFAULT_ITERATION_INTERVAL = 3;
const DEFAULT_MIN_ITERATIONS_BETWEEN = 2;

export function buildDreamReviewCheckpointRequest(
  input: BuildDreamReviewCheckpointRequestInput
): DreamReviewCheckpointRequest | null {
  const trigger = input.requestedTrigger ?? inferCheckpointTrigger(input);
  if (!trigger) return null;
  if (!rateLimitAllows(input, trigger)) return null;

  const activeDimensions = topDimensions(input.driveScores, input.goal);
  const metricTrendSummary = input.result.metricTrendContext?.summary;
  return {
    trigger,
    reason: reasonForTrigger(trigger, input),
    activeDimensions,
    ...(input.evidenceSummary?.best_evidence ? { bestEvidenceSummary: entrySummary(input.evidenceSummary.best_evidence) } : {}),
    recentStrategyFamilies: recentStrategyFamilies(input.evidenceSummary?.recent_entries ?? []),
    ...(metricTrendSummary ? { metricTrendSummary } : {}),
    ...(input.finalizationStatus?.reason ? { finalizationReason: input.finalizationStatus.reason } : {}),
    memoryAuthorityPolicy: "soil_and_playbooks_are_advisory_only",
    maxGuidanceItems: 3,
  };
}

export function normalizeDreamReviewCheckpoint(
  output: DreamReviewCheckpointEvidence,
  request: DreamReviewCheckpointRequest,
  goal: Goal
): DreamReviewCheckpointEvidence {
  return {
    ...output,
    trigger: output.trigger ?? request.trigger,
    current_goal: output.current_goal || goal.title,
    active_dimensions: output.active_dimensions.length > 0 ? output.active_dimensions : request.activeDimensions,
    relevant_memories: output.relevant_memories.map((memory) => ({
      ...memory,
      authority: "advisory_only",
    })),
    context_authority: "advisory_only",
  };
}

export function dreamCheckpointRawRefs(
  output: DreamReviewCheckpointEvidence
): Array<{ kind: string; id?: string }> {
  return output.relevant_memories
    .map((memory) => memory.ref ? { kind: `dream_${memory.source_type}_memory`, id: memory.ref } : null)
    .filter((ref): ref is { kind: string; id: string } => ref !== null);
}

function inferCheckpointTrigger(
  input: BuildDreamReviewCheckpointRequestInput
): DreamReviewCheckpointTrigger | null {
  if (isPreFinalization(input.finalizationStatus)) return "pre_finalization";
  if (input.result.metricTrendContext?.trend === "breakthrough") return "breakthrough";
  if (
    input.result.stallDetected
    || input.result.metricTrendContext?.trend === "stalled"
    || input.result.metricTrendContext?.trend === "regressing"
  ) {
    return "plateau";
  }

  const interval = input.options?.iterationInterval ?? DEFAULT_ITERATION_INTERVAL;
  if (interval > 0 && input.loopIndex > 0 && input.loopIndex % interval === 0) return "iteration";
  return null;
}

function isPreFinalization(status: DeadlineFinalizationStatus | undefined): boolean {
  return status?.mode === "finalization" || status?.mode === "missed_deadline";
}

function rateLimitAllows(
  input: BuildDreamReviewCheckpointRequestInput,
  trigger: DreamReviewCheckpointTrigger
): boolean {
  const latest = trigger === "pre_finalization"
    ? input.recentCheckpoints?.find((checkpoint) =>
        checkpoint.trigger === "pre_finalization" && checkpoint.loop_index !== undefined
      )
    : input.recentCheckpoints?.find((checkpoint) => checkpoint.loop_index !== undefined);
  if (!latest || latest.loop_index === undefined) return true;
  const minIterations = input.options?.minIterationsBetween ?? DEFAULT_MIN_ITERATIONS_BETWEEN;
  return input.loopIndex - latest.loop_index >= minIterations;
}

function reasonForTrigger(
  trigger: DreamReviewCheckpointTrigger,
  input: BuildDreamReviewCheckpointRequestInput
): string {
  if (trigger === "pre_finalization") {
    return `Review accumulated evidence before finalization: ${input.finalizationStatus?.reason ?? "deadline finalization is active"}`;
  }
  if (trigger === "breakthrough") {
    return `Metric breakthrough detected: ${input.result.metricTrendContext?.summary ?? "trend improved sharply"}`;
  }
  if (trigger === "plateau") {
    return input.result.metricTrendContext?.summary
      ? `Plateau/regression detected from metric trend: ${input.result.metricTrendContext.summary}`
      : "Progress plateau or stall detected.";
  }
  return `Scheduled iteration checkpoint at loop ${input.loopIndex}.`;
}

function topDimensions(driveScores: DriveScore[], goal: Goal): string[] {
  const scored = driveScores.slice(0, 3).map((score) => score.dimension_name);
  if (scored.length > 0) return scored;
  return goal.dimensions.slice(0, 3).map((dimension) => dimension.name);
}

function recentStrategyFamilies(entries: RuntimeEvidenceEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    const candidate = entry.strategy ?? entry.task?.action ?? entry.task?.primary_dimension;
    if (!candidate) continue;
    seen.add(candidate);
    if (seen.size >= 5) break;
  }
  return [...seen];
}

function entrySummary(entry: RuntimeEvidenceEntry): string {
  return entry.summary
    ?? entry.result?.summary
    ?? entry.verification?.summary
    ?? entry.decision_reason
    ?? entry.kind;
}
