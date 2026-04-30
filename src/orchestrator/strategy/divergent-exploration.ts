import { randomUUID } from "node:crypto";
import { parseStrategy } from "../../base/types/strategy.js";
import type {
  Strategy,
  StrategyExplorationExpectedCost,
  StrategyExplorationRole,
  StrategyLineageRelationship,
  StrategySmokeStatus,
} from "../../base/types/strategy.js";
import type { MetricTrendContext } from "../../platform/drive/metric-history.js";
import type { RuntimeEvidenceDivergentHypothesis } from "../../runtime/store/evidence-ledger.js";

export interface DivergentRecoveryInput {
  goalId: string;
  primaryDimension: string;
  targetDimensions: string[];
  currentGap: number;
  pastStrategies: Strategy[];
  activeStrategy?: Strategy | null;
  stallCount: number;
  trigger?: "sustained_stall" | "predicted_plateau" | "predicted_regression";
  metricTrendContext?: MetricTrendContext;
  minDivergentCandidates?: number;
  minNoveltyScore?: number;
}

export interface DivergentRecoveryPortfolio {
  candidates: Strategy[];
  insertedFallback: boolean;
  minDivergentCandidates: number;
  minNoveltyScore: number;
}

export interface DivergentSmokeResultInput {
  status: Extract<StrategySmokeStatus, "promote" | "defer" | "retire">;
  reason: string;
  evidenceRef?: string;
}

const DEFAULT_MIN_DIVERGENT_CANDIDATES = 1;
const DEFAULT_MIN_NOVELTY_SCORE = 0.72;
const TOKEN_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "around",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "use",
  "using",
  "with",
]);

export function shouldRequestDivergentExploration(input: {
  stallCount: number;
  trigger?: "sustained_stall" | "predicted_plateau" | "predicted_regression";
  metricTrendContext?: MetricTrendContext;
}): boolean {
  if (input.stallCount >= 2) return true;
  if (input.trigger === "predicted_plateau" || input.trigger === "predicted_regression") return true;
  return input.metricTrendContext?.trend === "stalled" || input.metricTrendContext?.trend === "regressing";
}

export function buildDivergentRecoveryPortfolio(
  rawCandidates: Strategy[],
  input: DivergentRecoveryInput
): DivergentRecoveryPortfolio {
  const minDivergentCandidates = input.minDivergentCandidates ?? DEFAULT_MIN_DIVERGENT_CANDIDATES;
  const minNoveltyScore = input.minNoveltyScore ?? DEFAULT_MIN_NOVELTY_SCORE;
  if (rawCandidates.length === 0) {
    return {
      candidates: [],
      insertedFallback: false,
      minDivergentCandidates,
      minNoveltyScore,
    };
  }
  const lineage = buildLineage(input);
  const annotated = rawCandidates.map((candidate) =>
    annotateCandidate(candidate, input, lineage, minNoveltyScore)
  );
  const highNoveltyCount = annotated.filter((candidate) =>
    candidate.exploration?.role === "divergent_exploration"
    && (candidate.exploration.novelty_score ?? 0) >= minNoveltyScore
    && candidate.exploration.smoke.status !== "retire"
  ).length;

  let candidates = annotated;
  let insertedFallback = false;
  if (highNoveltyCount < minDivergentCandidates) {
    candidates = [
      buildFallbackDivergentCandidate(input, lineage, minNoveltyScore),
      ...candidates,
    ];
    insertedFallback = true;
  }

  return {
    candidates: rankDivergentCandidates(candidates),
    insertedFallback,
    minDivergentCandidates,
    minNoveltyScore,
  };
}

export function rankDivergentCandidates(candidates: Strategy[]): Strategy[] {
  return [...candidates].sort((left, right) =>
    scoreCandidate(right) - scoreCandidate(left)
    || left.created_at.localeCompare(right.created_at)
    || left.id.localeCompare(right.id)
  );
}

export function applySmokeResult(strategy: Strategy, input: DivergentSmokeResultInput): Strategy {
  const exploration = strategy.exploration;
  if (!exploration) {
    return parseStrategy({
      ...strategy,
      exploration: {
        schema_version: "strategy-exploration-v1",
        phase: "divergent_stall_recovery",
        role: "adjacent_exploration",
        strategy_family: inferStrategyFamily(strategy.hypothesis),
        novelty_score: 0.5,
        similarity_to_recent_failures: 0,
        expected_cost: inferExpectedCost(strategy),
        relationship_to_lineage: "unknown",
        smoke: {
          status: input.status,
          reason: input.reason,
          ...(input.evidenceRef ? { evidence_ref: input.evidenceRef } : {}),
        },
        speculative: true,
        evidence_authority: "speculative_hypothesis",
      },
    });
  }
  return parseStrategy({
    ...strategy,
    allocation: input.status === "promote" ? Math.max(strategy.allocation, 0.35) : strategy.allocation,
    exploration: {
      ...exploration,
      downrank_reason: input.status === "retire"
        ? input.reason
        : input.status === "defer"
          ? input.reason
          : exploration.downrank_reason,
      smoke: {
        status: input.status,
        reason: input.reason,
        ...(input.evidenceRef ? { evidence_ref: input.evidenceRef } : {}),
      },
    },
  });
}

export function collectDivergentHypotheses(strategies: Strategy[]): RuntimeEvidenceDivergentHypothesis[] {
  return strategies
    .filter((strategy) => strategy.exploration?.phase === "divergent_stall_recovery")
    .map((strategy) => ({
      strategy_id: strategy.id,
      hypothesis: strategy.hypothesis,
      strategy_family: strategy.exploration!.strategy_family,
      role: strategy.exploration!.role,
      novelty_score: strategy.exploration!.novelty_score,
      similarity_to_recent_failures: strategy.exploration!.similarity_to_recent_failures,
      expected_cost: strategy.exploration!.expected_cost,
      relationship_to_lineage: strategy.exploration!.relationship_to_lineage,
      prior_evidence: strategy.exploration!.prior_evidence,
      downrank_reason: strategy.exploration!.downrank_reason,
      smoke_status: strategy.exploration!.smoke.status,
      smoke_reason: strategy.exploration!.smoke.reason,
      smoke_evidence_ref: strategy.exploration!.smoke.evidence_ref,
      evidence_authority: "speculative_hypothesis",
    }));
}

function annotateCandidate(
  candidate: Strategy,
  input: DivergentRecoveryInput,
  lineage: Strategy[],
  minNoveltyScore: number
): Strategy {
  const maxSimilarity = Math.max(0, ...lineage.map((strategy) => similarity(candidate.hypothesis, strategy.hypothesis)));
  const family = candidate.exploration?.strategy_family ?? inferStrategyFamily(candidate.hypothesis);
  const lineageFamilies = new Set(lineage.map((strategy) => inferStrategyFamily(strategy.hypothesis)));
  const hasNewEvidence = Boolean(candidate.exploration?.prior_evidence)
    || input.metricTrendContext?.trend === "breakthrough"
    || candidate.exploration?.smoke.status === "promote";
  const noveltyScore = clamp01(
    candidate.exploration?.novelty_score
    ?? (1 - maxSimilarity + (lineageFamilies.has(family) ? -0.1 : 0.15))
  );
  const relationship = candidate.exploration?.relationship_to_lineage
    ?? inferRelationship(maxSimilarity, family, lineageFamilies);
  const role = candidate.exploration?.role ?? roleFromNovelty(noveltyScore, minNoveltyScore);
  const downrankReason = candidate.exploration?.downrank_reason
    ?? (!hasNewEvidence && (maxSimilarity >= 0.5 || relationship === "failed_lineage")
      ? "similar_to_recent_failed_lineage_without_new_evidence"
      : undefined);

  return parseStrategy({
    ...candidate,
    allocation: candidate.allocation > 0
      ? candidate.allocation
      : role === "divergent_exploration" ? 0.35 : role === "adjacent_exploration" ? 0.25 : 0.2,
    exploration: {
      schema_version: "strategy-exploration-v1",
      phase: "divergent_stall_recovery",
      role,
      strategy_family: family,
      novelty_score: noveltyScore,
      similarity_to_recent_failures: clamp01(maxSimilarity),
      expected_cost: candidate.exploration?.expected_cost ?? inferExpectedCost(candidate),
      relationship_to_lineage: relationship,
      prior_evidence: candidate.exploration?.prior_evidence ?? input.metricTrendContext?.summary,
      downrank_reason: downrankReason,
      smoke: candidate.exploration?.smoke ?? {
        status: "not_run",
        reason: role === "divergent_exploration"
          ? "Run a smoke-scale probe before expensive execution."
          : "Smoke check optional before full execution.",
      },
      speculative: true,
      evidence_authority: "speculative_hypothesis",
    },
  });
}

function buildFallbackDivergentCandidate(
  input: DivergentRecoveryInput,
  lineage: Strategy[],
  minNoveltyScore: number
): Strategy {
  const failedFamilies = [...new Set(lineage.map((strategy) => inferStrategyFamily(strategy.hypothesis)))]
    .filter(Boolean)
    .slice(0, 3);
  const dimension = input.primaryDimension || input.targetDimensions[0] || "primary_outcome";
  const now = new Date().toISOString();
  return parseStrategy({
    id: randomUUID(),
    goal_id: input.goalId,
    target_dimensions: input.targetDimensions.length > 0 ? input.targetDimensions : [dimension],
    primary_dimension: dimension,
    hypothesis: `Run a smoke-scale divergent audit that challenges the current ${failedFamilies.join(", ") || "local-search"} framing with a different mechanism before more refinements`,
    expected_effect: [{
      dimension,
      direction: "increase",
      magnitude: "medium",
    }],
    resource_estimate: {
      sessions: 1,
      duration: { value: 30, unit: "minutes" },
      llm_calls: 1,
    },
    allocation: 0.35,
    state: "candidate",
    created_at: now,
    started_at: null,
    completed_at: null,
    gap_snapshot_at_start: input.currentGap,
    tasks_generated: [],
    effectiveness_score: null,
    consecutive_stall_count: 0,
    required_tools: [],
    exploration: {
      schema_version: "strategy-exploration-v1",
      phase: "divergent_stall_recovery",
      role: "divergent_exploration",
      strategy_family: "framing-audit-smoke",
      novelty_score: Math.max(minNoveltyScore, 0.82),
      similarity_to_recent_failures: 0,
      expected_cost: "low",
      relationship_to_lineage: "different_assumption",
      prior_evidence: input.metricTrendContext?.summary
        ?? "Existing stall recovery reached sustained stall without enough high-novelty hypotheses.",
      smoke: {
        status: "not_run",
        reason: "Smoke-scale audit only; promote to full execution only if it finds actionable evidence.",
      },
      speculative: true,
      evidence_authority: "speculative_hypothesis",
    },
  });
}

function buildLineage(input: DivergentRecoveryInput): Strategy[] {
  const failedOrStalled = input.pastStrategies.filter((strategy) =>
    strategy.state === "terminated"
    || (strategy.effectiveness_score !== null && strategy.effectiveness_score < 0.35)
    || strategy.consecutive_stall_count > 0
  );
  const best = input.pastStrategies
    .filter((strategy) => strategy.effectiveness_score !== null)
    .sort((left, right) => (right.effectiveness_score ?? 0) - (left.effectiveness_score ?? 0))[0];
  return [
    ...(input.activeStrategy ? [input.activeStrategy] : []),
    ...(best ? [best] : []),
    ...failedOrStalled,
  ].filter((strategy, index, all) => all.findIndex((candidate) => candidate.id === strategy.id) === index);
}

function scoreCandidate(strategy: Strategy): number {
  const exploration = strategy.exploration;
  if (!exploration) return 0;
  if (exploration.smoke.status === "retire") return -100;
  const roleScore = exploration.role === "divergent_exploration"
    ? 3
    : exploration.role === "adjacent_exploration"
      ? 1.5
      : 0.5;
  const smokeScore = exploration.smoke.status === "promote"
    ? 2
    : exploration.smoke.status === "defer"
      ? -1
      : 0;
  const downrank = exploration.downrank_reason ? -1.5 : 0;
  const costPenalty = exploration.expected_cost === "high" ? -0.4 : exploration.expected_cost === "medium" ? -0.1 : 0.2;
  return roleScore + smokeScore + downrank + costPenalty + exploration.novelty_score - exploration.similarity_to_recent_failures;
}

function inferStrategyFamily(hypothesis: string): string {
  const normalized = hypothesis.toLowerCase();
  if (/\b(stack|ensemble|blend|multi[- ]model|probability)\b/.test(normalized)) return "model-stack";
  if (/\b(feature|cross|interaction|encoding|embedding)\b/.test(normalized)) return "feature-engineering";
  if (/\b(audit|distribution|leakage|label|noise|data)\b/.test(normalized)) return "data-audit";
  if (/\b(calibration|threshold|bias|class[- ]weight|weight)\b/.test(normalized)) return "calibration-threshold";
  if (/\b(catboost|xgboost|lightgbm|model|classifier)\b/.test(normalized)) return "model-family";
  if (/\b(research|public|paper|writeup|source)\b/.test(normalized)) return "source-research";
  return tokens(hypothesis).slice(0, 3).join("-") || "general";
}

function inferExpectedCost(strategy: Strategy): StrategyExplorationExpectedCost {
  const duration = strategy.resource_estimate.duration;
  const unit = duration.unit;
  const value = duration.value;
  if (strategy.resource_estimate.sessions <= 1 && (unit === "minutes" || (unit === "hours" && value <= 2))) {
    return "low";
  }
  if (unit === "days" || unit === "weeks" || strategy.resource_estimate.sessions >= 4) {
    return "high";
  }
  return "medium";
}

function inferRelationship(
  maxSimilarity: number,
  family: string,
  lineageFamilies: ReadonlySet<string>
): StrategyLineageRelationship {
  if (maxSimilarity >= 0.7) return "failed_lineage";
  if (maxSimilarity >= 0.45 || lineageFamilies.has(family)) return "neighbor";
  if (/audit|research|framing/.test(family)) return "different_assumption";
  return "different_mechanism";
}

function roleFromNovelty(noveltyScore: number, minNoveltyScore: number): StrategyExplorationRole {
  if (noveltyScore >= minNoveltyScore) return "divergent_exploration";
  if (noveltyScore >= 0.45) return "adjacent_exploration";
  return "exploitation";
}

function similarity(left: string, right: string): number {
  const leftTokens = new Set(tokens(left));
  const rightTokens = new Set(tokens(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !TOKEN_STOP_WORDS.has(token));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
