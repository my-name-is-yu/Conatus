import type {
  RuntimeEvidenceArtifactRef,
  RuntimeEvidenceEntry,
  RuntimeEvidenceEvaluatorBudget,
  RuntimeEvidenceEvaluatorCalibration,
  RuntimeEvidenceEvaluatorCandidateSnapshot,
  RuntimeEvidenceEvaluatorObservation,
  RuntimeEvidenceEvaluatorProvenance,
  RuntimeEvidenceEvaluatorPublishAction,
  RuntimeEvidenceEvaluatorStatus,
  RuntimeEvidenceMetric,
} from "./evidence-types.js";

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
  budget?: RuntimeEvidenceEvaluatorBudget;
  candidate_snapshot?: RuntimeEvidenceEvaluatorCandidateSnapshot;
  calibration?: RuntimeEvidenceEvaluatorCalibration;
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

export interface RuntimeEvaluatorBudgetSummary {
  evaluator_id: string;
  source: string;
  policy_id?: string;
  max_attempts?: number;
  used_attempts?: number;
  remaining_attempts: number;
  approval_required: boolean;
  deadline_at?: string;
  phase?: "exploration" | "consolidation" | "finalization" | "other";
  diversified_portfolio_required: boolean;
  reserve_for_finalization: boolean;
  min_strategy_families?: number;
  observed_at: string;
}

export interface RuntimeEvaluatorCalibrationContext {
  evaluator_id: string;
  source: string;
  candidate_id: string;
  observed_at: string;
  local_evidence_entry_id?: string;
  external_evidence_entry_id: string;
  local_score?: number;
  external_score?: number;
  score_delta?: number;
  direction?: EvaluatorDirection;
  use_for_selection: boolean;
  direct_optimization_allowed: false;
  minimum_observations: number;
  selection_adjustment: number;
  conclusion: string;
  provenance?: RuntimeEvidenceEvaluatorProvenance;
  candidate_snapshot?: RuntimeEvidenceEvaluatorCandidateSnapshot;
}

export interface RuntimeEvaluatorSummary {
  local_best: RuntimeEvaluatorObservationContext | null;
  external_best: RuntimeEvaluatorObservationContext | null;
  gap: RuntimeEvaluatorGap | null;
  budgets: RuntimeEvaluatorBudgetSummary[];
  calibration: RuntimeEvaluatorCalibrationContext[];
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
    budgets: summarizeEvaluatorBudgets(observations),
    calibration: summarizeEvaluatorCalibration(observations),
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
    ...(evaluator.budget ? { budget: evaluator.budget } : {}),
    ...(evaluator.candidate_snapshot ? { candidate_snapshot: evaluator.candidate_snapshot } : {}),
    ...(evaluator.calibration ? { calibration: evaluator.calibration } : {}),
    ...(evaluator.summary ? { summary: evaluator.summary } : {}),
    raw_refs: entry.raw_refs,
  };
}

function summarizeEvaluatorBudgets(
  observations: RuntimeEvaluatorObservationContext[]
): RuntimeEvaluatorBudgetSummary[] {
  const latest = new Map<string, RuntimeEvaluatorBudgetSummary>();
  for (const observation of observations) {
    if (!observation.budget) continue;
    const policyId = observation.budget.policy_id ?? "default";
    const key = `${observation.evaluator_id}:${observation.source}:${policyId}`;
    const summary: RuntimeEvaluatorBudgetSummary = {
      evaluator_id: observation.evaluator_id,
      source: observation.source,
      ...(observation.budget.policy_id ? { policy_id: observation.budget.policy_id } : {}),
      ...(observation.budget.max_attempts !== undefined ? { max_attempts: observation.budget.max_attempts } : {}),
      ...(observation.budget.used_attempts !== undefined ? { used_attempts: observation.budget.used_attempts } : {}),
      remaining_attempts: observation.budget.remaining_attempts,
      approval_required: observation.budget.approval_required,
      ...(observation.budget.deadline_at ? { deadline_at: observation.budget.deadline_at } : {}),
      ...(observation.budget.phase ? { phase: observation.budget.phase } : {}),
      diversified_portfolio_required: observation.budget.portfolio_policy?.diversified_portfolio_required ?? false,
      reserve_for_finalization: observation.budget.portfolio_policy?.reserve_for_finalization ?? false,
      ...(observation.budget.portfolio_policy?.min_strategy_families
        ? { min_strategy_families: observation.budget.portfolio_policy.min_strategy_families }
        : {}),
      observed_at: observation.observed_at,
    };
    const existing = latest.get(key);
    if (!existing || existing.observed_at <= summary.observed_at) latest.set(key, summary);
  }
  return [...latest.values()].sort((a, b) =>
    a.evaluator_id.localeCompare(b.evaluator_id)
    || a.source.localeCompare(b.source)
    || a.observed_at.localeCompare(b.observed_at)
  );
}

function summarizeEvaluatorCalibration(
  observations: RuntimeEvaluatorObservationContext[]
): RuntimeEvaluatorCalibrationContext[] {
  return observations
    .filter((observation) => observation.signal === "external" && observation.calibration?.mode === "calibration_only")
    .map((observation) => toCalibrationContext(observation))
    .filter((calibration): calibration is RuntimeEvaluatorCalibrationContext => Boolean(calibration))
    .sort((a, b) => a.observed_at.localeCompare(b.observed_at));
}

function toCalibrationContext(
  observation: RuntimeEvaluatorObservationContext
): RuntimeEvaluatorCalibrationContext | null {
  const calibration = observation.calibration;
  if (!calibration) return null;
  const externalScore = numericScore(observation.score);
  const localScore = candidateSnapshotPrimaryScore(observation);
  const direction = observation.direction;
  const scoreDelta = externalScore !== null && localScore !== null ? externalScore - localScore : undefined;
  const directionalGap = scoreDelta === undefined || !direction || direction === "neutral"
    ? 0
    : direction === "maximize"
      ? scoreDelta
      : -scoreDelta;
  return {
    evaluator_id: observation.evaluator_id,
    source: observation.source,
    candidate_id: observation.candidate_id,
    observed_at: observation.observed_at,
    ...(observation.candidate_snapshot?.evidence_entry_id ? { local_evidence_entry_id: observation.candidate_snapshot.evidence_entry_id } : {}),
    external_evidence_entry_id: observation.entry_id,
    ...(localScore !== null ? { local_score: localScore } : {}),
    ...(externalScore !== null ? { external_score: externalScore } : {}),
    ...(scoreDelta !== undefined ? { score_delta: scoreDelta } : {}),
    ...(direction ? { direction } : {}),
    use_for_selection: calibration.use_for_selection,
    direct_optimization_allowed: false,
    minimum_observations: calibration.minimum_observations,
    selection_adjustment: roundCalibrationAdjustment(directionalGap * 4),
    conclusion: calibration.conclusion ?? "External evaluator feedback is calibration evidence only; primary optimization remains local validation.",
    ...(observation.provenance ? { provenance: observation.provenance } : {}),
    ...(observation.candidate_snapshot ? { candidate_snapshot: observation.candidate_snapshot } : {}),
  };
}

function candidateSnapshotPrimaryScore(observation: RuntimeEvaluatorObservationContext): number | null {
  const metrics = observation.candidate_snapshot?.local_metrics ?? [];
  const metric = findLocalMetricForExternalScore(metrics, observation.score_label)
    ?? findLocalMetricForExternalScore(metrics, observation.candidate_snapshot?.primary_metric_label);
  return typeof metric?.value === "number" ? metric.value : null;
}

function findLocalMetricForExternalScore(
  metrics: RuntimeEvidenceMetric[],
  scoreLabel: string | undefined
): RuntimeEvidenceMetric | undefined {
  if (!scoreLabel) return undefined;
  const normalizedScoreLabel = normalizeMetricLabel(scoreLabel);
  return metrics.find((metric) =>
    normalizeMetricLabel(metric.label) === normalizedScoreLabel
    && typeof metric.value === "number"
    && Number.isFinite(metric.value)
  );
}

function normalizeMetricLabel(label: string): string {
  return label.normalize("NFKC").toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function roundCalibrationAdjustment(value: number): number {
  const clamped = Math.min(0.08, Math.max(-0.08, Number.isFinite(value) ? value : 0));
  return Math.round(clamped * 1_000_000) / 1_000_000;
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
