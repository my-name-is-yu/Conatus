import type {
  RuntimeEvidenceArtifactRef,
  RuntimeEvidenceEntry,
  RuntimeEvidenceEvaluatorObservation,
  RuntimeEvidenceEvaluatorProvenance,
  RuntimeEvidenceEvaluatorPublishAction,
  RuntimeEvidenceEvaluatorStatus,
} from "./evidence-ledger.js";

type EvaluatorDirection = "maximize" | "minimize" | "neutral";

export interface RuntimeEvaluatorObservationContext {
  entry_id: string;
  entry_kind: RuntimeEvidenceEntry["kind"];
  occurred_at: string;
  observed_at: string;
  evaluator_id: string;
  signal: "local" | "external";
  source: string;
  candidate_id: string;
  candidate_label?: string;
  artifact_labels: string[];
  artifacts: RuntimeEvidenceArtifactRef[];
  status: RuntimeEvidenceEvaluatorStatus;
  score?: string | number | boolean | null;
  score_label?: string;
  direction?: EvaluatorDirection;
  expected_score?: string | number | boolean | null;
  expected_status?: RuntimeEvidenceEvaluatorStatus;
  expectation_source?: string;
  validation?: RuntimeEvidenceEvaluatorObservation["validation"];
  publish_action?: RuntimeEvidenceEvaluatorPublishAction;
  provenance?: RuntimeEvidenceEvaluatorProvenance;
  summary?: string;
  raw_refs: RuntimeEvidenceEntry["raw_refs"];
}

export interface RuntimeEvaluatorApprovalRequiredAction extends Omit<RuntimeEvidenceEvaluatorPublishAction, "status"> {
  status: "approval_required" | "approved" | "submitted" | "completed" | "blocked";
  entry_id: string;
  evaluator_id: string;
  signal: "local" | "external";
  source: string;
  candidate_id: string;
  observed_at: string;
}

export type RuntimeEvaluatorGapKind =
  | "none"
  | "local_only"
  | "pending_external"
  | "external_success"
  | "external_regression"
  | "candidate_mismatch"
  | "inconclusive";

export interface RuntimeEvaluatorGap {
  kind: RuntimeEvaluatorGapKind;
  summary: string;
  evaluator_id?: string;
  candidate_id?: string;
  local_candidate_id?: string;
  external_candidate_id?: string;
  score_delta?: number;
  direction?: EvaluatorDirection;
}

export interface RuntimeEvaluatorSummary {
  local_best: RuntimeEvaluatorObservationContext | null;
  external_best: RuntimeEvaluatorObservationContext | null;
  gap: RuntimeEvaluatorGap | null;
  approval_required_actions: RuntimeEvaluatorApprovalRequiredAction[];
  observations: RuntimeEvaluatorObservationContext[];
}

export function extractEvaluatorObservationsFromEvidence(
  entries: RuntimeEvidenceEntry[]
): RuntimeEvaluatorObservationContext[] {
  const observations: RuntimeEvaluatorObservationContext[] = [];
  for (const entry of entries) {
    for (const evaluator of entry.evaluators ?? []) {
      observations.push(toObservationContext(entry, evaluator));
    }
  }
  return observations.sort(compareObservationTime);
}

export function summarizeEvidenceEvaluatorResults(entries: RuntimeEvidenceEntry[]): RuntimeEvaluatorSummary {
  const observations = extractEvaluatorObservationsFromEvidence(entries);
  const localObservations = observations.filter((observation) => observation.signal === "local");
  const externalObservations = observations.filter((observation) => observation.signal === "external");
  const localBest = selectBestObservation(localObservations);
  const externalBest = selectBestObservation(externalObservations.filter(isConfirmedExternalObservation));
  const approvalRequiredActions = collectApprovalRequiredActions(observations);

  return {
    local_best: localBest,
    external_best: externalBest,
    gap: classifyEvaluatorGap(localBest, externalBest, externalObservations, approvalRequiredActions),
    approval_required_actions: approvalRequiredActions,
    observations,
  };
}

function toObservationContext(
  entry: RuntimeEvidenceEntry,
  evaluator: RuntimeEvidenceEvaluatorObservation
): RuntimeEvaluatorObservationContext {
  return {
    entry_id: entry.id,
    entry_kind: entry.kind,
    occurred_at: entry.occurred_at,
    observed_at: evaluator.observed_at ?? entry.occurred_at,
    evaluator_id: evaluator.evaluator_id,
    signal: evaluator.signal,
    source: evaluator.source,
    candidate_id: evaluator.candidate_id,
    ...(evaluator.candidate_label ? { candidate_label: evaluator.candidate_label } : {}),
    artifact_labels: evaluator.artifact_labels ?? [],
    artifacts: selectArtifacts(entry.artifacts, evaluator.artifact_labels ?? []),
    status: evaluator.status,
    ...(evaluator.score !== undefined ? { score: evaluator.score } : {}),
    ...(evaluator.score_label ? { score_label: evaluator.score_label } : {}),
    ...(evaluator.direction ? { direction: evaluator.direction } : {}),
    ...(evaluator.expected_score !== undefined ? { expected_score: evaluator.expected_score } : {}),
    ...(evaluator.expected_status ? { expected_status: evaluator.expected_status } : {}),
    ...(evaluator.expectation_source ? { expectation_source: evaluator.expectation_source } : {}),
    ...(evaluator.validation ? { validation: evaluator.validation } : {}),
    ...(evaluator.publish_action ? { publish_action: evaluator.publish_action } : {}),
    ...(evaluator.provenance ? { provenance: evaluator.provenance } : {}),
    ...(evaluator.summary ? { summary: evaluator.summary } : {}),
    raw_refs: entry.raw_refs,
  };
}

function selectArtifacts(
  artifacts: RuntimeEvidenceArtifactRef[],
  artifactLabels: string[]
): RuntimeEvidenceArtifactRef[] {
  if (artifactLabels.length === 0) return artifacts;
  const wanted = new Set(artifactLabels);
  return artifacts.filter((artifact) => wanted.has(artifact.label));
}

function collectApprovalRequiredActions(
  observations: RuntimeEvaluatorObservationContext[]
): RuntimeEvaluatorApprovalRequiredAction[] {
  const actions = new Map<string, RuntimeEvaluatorApprovalRequiredAction>();
  for (const observation of observations) {
    const action = observation.publish_action;
    if (!action?.approval_required) continue;
    if (hasLaterExternalResult(observations, observation)) continue;
    const key = `${observation.evaluator_id}:${observation.candidate_id}:${action.id}`;
    if (action.status && action.status !== "approval_required") {
      actions.delete(key);
      continue;
    }
    actions.set(key, {
      ...action,
      status: action.status ?? "approval_required",
      entry_id: observation.entry_id,
      evaluator_id: observation.evaluator_id,
      signal: observation.signal,
      source: observation.source,
      candidate_id: observation.candidate_id,
      observed_at: observation.observed_at,
    });
  }
  return [...actions.values()].sort((a, b) => a.observed_at.localeCompare(b.observed_at));
}

function hasLaterExternalResult(
  observations: RuntimeEvaluatorObservationContext[],
  actionObservation: RuntimeEvaluatorObservationContext
): boolean {
  return observations.some((observation) =>
    observation.signal === "external"
    && observation.evaluator_id === actionObservation.evaluator_id
    && observation.candidate_id === actionObservation.candidate_id
    && observation.observed_at >= actionObservation.observed_at
    && isTerminalExternalStatus(observation.status)
  );
}

function isTerminalExternalStatus(status: RuntimeEvidenceEvaluatorStatus): boolean {
  return status === "passed"
    || status === "succeeded"
    || status === "completed"
    || status === "failed"
    || status === "regressed"
    || status === "blocked";
}

function selectBestObservation(
  observations: RuntimeEvaluatorObservationContext[]
): RuntimeEvaluatorObservationContext | null {
  let best: RuntimeEvaluatorObservationContext | null = null;
  for (const observation of observations) {
    if (!best || compareObservationQuality(observation, best) > 0) {
      best = observation;
    }
  }
  return best;
}

function classifyEvaluatorGap(
  localBest: RuntimeEvaluatorObservationContext | null,
  externalBest: RuntimeEvaluatorObservationContext | null,
  externalObservations: RuntimeEvaluatorObservationContext[],
  approvalRequiredActions: RuntimeEvaluatorApprovalRequiredAction[]
): RuntimeEvaluatorGap | null {
  if (!localBest && !externalBest && externalObservations.length === 0) return null;
  if (!localBest) {
    return {
      kind: "inconclusive",
      summary: "External evaluator evidence exists, but no local baseline has been recorded.",
      ...(externalBest ? { evaluator_id: externalBest.evaluator_id, external_candidate_id: externalBest.candidate_id } : {}),
    };
  }

  const externalForLocal = latestExternalForLocalCandidate(externalObservations, localBest);
  if (!externalForLocal) {
    if (externalBest && externalBest.candidate_id !== localBest.candidate_id) {
      return {
        kind: "candidate_mismatch",
        summary: `Local best is ${candidateLabel(localBest)}, but externally confirmed best is ${candidateLabel(externalBest)}.`,
        evaluator_id: localBest.evaluator_id,
        local_candidate_id: localBest.candidate_id,
        external_candidate_id: externalBest.candidate_id,
      };
    }
    const pendingAction = approvalRequiredActions.find((action) =>
      action.evaluator_id === localBest.evaluator_id && action.candidate_id === localBest.candidate_id
    );
    return {
      kind: pendingAction ? "pending_external" : "local_only",
      summary: pendingAction
        ? `Local best ${candidateLabel(localBest)} is ready for external evaluation, but ${pendingAction.label} requires approval.`
        : `Local best ${candidateLabel(localBest)} has no external evaluator result yet.`,
      evaluator_id: localBest.evaluator_id,
      candidate_id: localBest.candidate_id,
    };
  }

  const scoreDelta = computeScoreDelta(localBest, externalForLocal);
  const direction = externalForLocal.direction ?? localBest.direction;
  if (isExternalRegression(localBest, externalForLocal)) {
    return {
      kind: "external_regression",
      summary: `External evaluator result for ${candidateLabel(localBest)} regressed against local expectations.`,
      evaluator_id: localBest.evaluator_id,
      candidate_id: localBest.candidate_id,
      ...(scoreDelta !== null ? { score_delta: scoreDelta } : {}),
      ...(direction ? { direction } : {}),
    };
  }

  if (isConfirmedExternalObservation(externalForLocal)) {
    return {
      kind: "external_success",
      summary: `External evaluator confirmed local best ${candidateLabel(localBest)}.`,
      evaluator_id: localBest.evaluator_id,
      candidate_id: localBest.candidate_id,
      ...(scoreDelta !== null ? { score_delta: scoreDelta } : {}),
      ...(direction ? { direction } : {}),
    };
  }

  if (externalForLocal.status === "pending" || externalForLocal.status === "submitted" || externalForLocal.status === "approval_required") {
    return {
      kind: "pending_external",
      summary: `External evaluator result for ${candidateLabel(localBest)} is still pending.`,
      evaluator_id: localBest.evaluator_id,
      candidate_id: localBest.candidate_id,
    };
  }

  return {
    kind: "inconclusive",
    summary: `External evaluator result for ${candidateLabel(localBest)} is not yet comparable to local evidence.`,
    evaluator_id: localBest.evaluator_id,
    candidate_id: localBest.candidate_id,
  };
}

function latestExternalForLocalCandidate(
  externalObservations: RuntimeEvaluatorObservationContext[],
  localBest: RuntimeEvaluatorObservationContext
): RuntimeEvaluatorObservationContext | null {
  const newestFirst = [...externalObservations].reverse();
  return newestFirst.find((observation) =>
    observation.evaluator_id === localBest.evaluator_id
    && observation.candidate_id === localBest.candidate_id
  )
    ?? newestFirst.find((observation) => observation.candidate_id === localBest.candidate_id)
    ?? null;
}

function isExternalRegression(
  localBest: RuntimeEvaluatorObservationContext,
  externalObservation: RuntimeEvaluatorObservationContext
): boolean {
  if (externalObservation.status === "failed" || externalObservation.status === "regressed") return true;
  const baseline = numericScore(externalObservation.expected_score) ?? numericScore(localBest.score);
  const externalScore = numericScore(externalObservation.score);
  const direction = externalObservation.direction ?? localBest.direction;
  if (baseline === null || externalScore === null || !direction || direction === "neutral") return false;
  return direction === "maximize"
    ? externalScore < baseline
    : externalScore > baseline;
}

function isConfirmedExternalObservation(observation: RuntimeEvaluatorObservationContext): boolean {
  return observation.signal === "external"
    && (
      observation.status === "passed"
      || observation.status === "succeeded"
      || observation.status === "completed"
    );
}

function compareObservationQuality(
  left: RuntimeEvaluatorObservationContext,
  right: RuntimeEvaluatorObservationContext
): number {
  const direction = left.direction ?? right.direction;
  const leftScore = numericScore(left.score);
  const rightScore = numericScore(right.score);
  if (leftScore !== null && rightScore !== null && direction && direction !== "neutral") {
    return direction === "maximize"
      ? leftScore - rightScore
      : rightScore - leftScore;
  }

  const statusDelta = statusRank(left.status) - statusRank(right.status);
  if (statusDelta !== 0) return statusDelta;
  return left.observed_at.localeCompare(right.observed_at);
}

function compareObservationTime(
  left: RuntimeEvaluatorObservationContext,
  right: RuntimeEvaluatorObservationContext
): number {
  const observedDelta = left.observed_at.localeCompare(right.observed_at);
  if (observedDelta !== 0) return observedDelta;
  return left.entry_id.localeCompare(right.entry_id);
}

function statusRank(status: RuntimeEvidenceEvaluatorStatus): number {
  switch (status) {
    case "passed":
    case "succeeded":
    case "completed":
      return 5;
    case "ready":
    case "submitted":
      return 4;
    case "approval_required":
    case "pending":
      return 3;
    case "unknown":
      return 2;
    case "blocked":
      return 1;
    case "failed":
    case "regressed":
      return 0;
  }
}

function computeScoreDelta(
  localBest: RuntimeEvaluatorObservationContext,
  externalObservation: RuntimeEvaluatorObservationContext
): number | null {
  const baseline = numericScore(externalObservation.expected_score) ?? numericScore(localBest.score);
  const externalScore = numericScore(externalObservation.score);
  if (baseline === null || externalScore === null) return null;
  return externalScore - baseline;
}

function numericScore(score: RuntimeEvaluatorObservationContext["score"] | undefined): number | null {
  if (typeof score !== "number") return null;
  return Number.isFinite(score) ? score : null;
}

function candidateLabel(observation: RuntimeEvaluatorObservationContext): string {
  return observation.candidate_label ?? observation.candidate_id;
}
