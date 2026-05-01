import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import {
  createRuntimeStorePaths,
  ensureRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import { summarizeEvidenceMetricTrends, type MetricTrendContext } from "./metric-history.js";
import {
  summarizeEvidenceEvaluatorResults,
  type RuntimeEvaluatorSummary,
} from "./evaluator-results.js";
import {
  summarizeEvidenceResearchMemos,
  type RuntimeResearchMemoContext,
} from "./research-evidence.js";
import {
  summarizeEvidenceDreamCheckpoints,
  type RuntimeDreamCheckpointContext,
} from "./dream-checkpoints.js";

export const RuntimeEvidenceOutcomeSchema = z.enum([
  "improved",
  "regressed",
  "inconclusive",
  "failed",
  "blocked",
  "continued",
]);
export type RuntimeEvidenceOutcome = z.infer<typeof RuntimeEvidenceOutcomeSchema>;

export const RuntimeEvidenceEntryKindSchema = z.enum([
  "observation",
  "strategy",
  "task_generation",
  "execution",
  "verification",
  "decision",
  "metric",
  "evaluator",
  "research",
  "dream_checkpoint",
  "artifact",
  "failure",
  "other",
]);
export type RuntimeEvidenceEntryKind = z.infer<typeof RuntimeEvidenceEntryKindSchema>;

export const RuntimeEvidenceArtifactRefSchema = z.object({
  label: z.string().min(1),
  path: z.string().min(1).optional(),
  state_relative_path: z.string().min(1).optional(),
  url: z.string().url().optional(),
  kind: z.enum(["log", "metrics", "report", "diff", "url", "other"]).default("other"),
}).strict();
export type RuntimeEvidenceArtifactRef = z.infer<typeof RuntimeEvidenceArtifactRefSchema>;

export const RuntimeEvidenceMetricSchema = z.object({
  label: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  unit: z.string().min(1).optional(),
  direction: z.enum(["maximize", "minimize", "neutral"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
  observed_at: z.string().datetime().optional(),
  source: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
}).strict();
export type RuntimeEvidenceMetric = z.infer<typeof RuntimeEvidenceMetricSchema>;

export const RuntimeEvidenceCandidateDispositionSchema = z.enum(["retained", "promoted", "retired"]);
export type RuntimeEvidenceCandidateDisposition = z.infer<typeof RuntimeEvidenceCandidateDispositionSchema>;

export const RuntimeEvidenceCandidateLineageSchema = z.object({
  parent_candidate_id: z.string().min(1).optional(),
  source_candidate_id: z.string().min(1).optional(),
  source_strategy_id: z.string().min(1).optional(),
  source_strategy: z.string().min(1).optional(),
  strategy_family: z.string().min(1),
  feature_lineage: z.array(z.string().min(1)).default([]),
  model_lineage: z.array(z.string().min(1)).default([]),
  config_lineage: z.array(z.string().min(1)).default([]),
  seed_lineage: z.array(z.string().min(1)).default([]),
  fold_lineage: z.array(z.string().min(1)).default([]),
  postprocess_lineage: z.array(z.string().min(1)).default([]),
  notes: z.string().min(1).optional(),
}).strict();
export type RuntimeEvidenceCandidateLineage = z.infer<typeof RuntimeEvidenceCandidateLineageSchema>;

export const RuntimeEvidenceCandidateSimilaritySchema = z.object({
  candidate_id: z.string().min(1),
  similarity: z.number().min(0).max(1),
  signal: z.enum(["declared", "lineage", "metric_correlation", "artifact_overlap", "other"]).default("declared"),
  summary: z.string().min(1).optional(),
}).strict();
export type RuntimeEvidenceCandidateSimilarity = z.infer<typeof RuntimeEvidenceCandidateSimilaritySchema>;

export const RuntimeEvidenceCandidateRecordSchema = z.object({
  candidate_id: z.string().min(1),
  label: z.string().min(1).optional(),
  lineage: RuntimeEvidenceCandidateLineageSchema,
  metrics: z.array(RuntimeEvidenceMetricSchema).default([]),
  artifacts: z.array(RuntimeEvidenceArtifactRefSchema).default([]),
  similarity: z.array(RuntimeEvidenceCandidateSimilaritySchema).default([]),
  robustness: z.object({
    stability_score: z.number().min(0).max(1).optional(),
    diversity_score: z.number().min(0).max(1).optional(),
    risk_penalty: z.number().min(0).max(1).optional(),
    robust_score: z.number().min(0).max(1).optional(),
    evidence_confidence: z.number().min(0).max(1).optional(),
    repeated_evaluations: z.number().int().nonnegative().optional(),
    mean_score: z.number().optional(),
    max_score: z.number().optional(),
    score_stddev: z.number().min(0).optional(),
    fold_score_range: z.number().min(0).optional(),
    seed_score_range: z.number().min(0).optional(),
    weak_dimensions: z.array(z.string().min(1)).default([]),
    provenance_refs: z.array(z.string().min(1)).default([]),
    summary: z.string().min(1).optional(),
  }).strict().optional(),
  disposition: RuntimeEvidenceCandidateDispositionSchema.default("retained"),
  disposition_reason: z.string().min(1).optional(),
  produced_at: z.string().datetime().optional(),
}).strict();
export type RuntimeEvidenceCandidateRecord = z.infer<typeof RuntimeEvidenceCandidateRecordSchema>;

export const RuntimeEvidenceEvaluatorSignalSchema = z.enum(["local", "external"]);
export type RuntimeEvidenceEvaluatorSignal = z.infer<typeof RuntimeEvidenceEvaluatorSignalSchema>;

export const RuntimeEvidenceEvaluatorStatusSchema = z.enum([
  "pending",
  "ready",
  "approval_required",
  "submitted",
  "passed",
  "succeeded",
  "completed",
  "failed",
  "regressed",
  "blocked",
  "unknown",
]);
export type RuntimeEvidenceEvaluatorStatus = z.infer<typeof RuntimeEvidenceEvaluatorStatusSchema>;

export const RuntimeEvidenceEvaluatorPublishActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  tool_name: z.string().min(1).optional(),
  payload_ref: z.string().min(1).optional(),
  approval_required: z.literal(true).default(true),
  status: z.enum(["approval_required", "approved", "submitted", "completed", "blocked"]).optional(),
}).strict();
export type RuntimeEvidenceEvaluatorPublishAction = z.infer<typeof RuntimeEvidenceEvaluatorPublishActionSchema>;

export const RuntimeEvidenceEvaluatorValidationSchema = z.object({
  status: z.enum(["pending", "passed", "failed", "blocked", "unknown"]).default("unknown"),
  command: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
}).strict();
export type RuntimeEvidenceEvaluatorValidation = z.infer<typeof RuntimeEvidenceEvaluatorValidationSchema>;

export const RuntimeEvidenceEvaluatorProvenanceSchema = z.object({
  kind: z.enum(["local_command", "external_url", "ci", "benchmark", "human_review", "other"]).default("other"),
  command: z.string().min(1).optional(),
  url: z.string().url().optional(),
  run_id: z.string().min(1).optional(),
  external_id: z.string().min(1).optional(),
  raw_ref: z.string().min(1).optional(),
  retrieved_at: z.string().datetime().optional(),
}).strict();
export type RuntimeEvidenceEvaluatorProvenance = z.infer<typeof RuntimeEvidenceEvaluatorProvenanceSchema>;

export const RuntimeEvidenceEvaluatorObservationSchema = z.object({
  evaluator_id: z.string().min(1),
  signal: RuntimeEvidenceEvaluatorSignalSchema,
  source: z.string().min(1),
  candidate_id: z.string().min(1),
  candidate_label: z.string().min(1).optional(),
  artifact_labels: z.array(z.string().min(1)).optional(),
  status: RuntimeEvidenceEvaluatorStatusSchema.default("unknown"),
  score: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  score_label: z.string().min(1).optional(),
  direction: z.enum(["maximize", "minimize", "neutral"]).optional(),
  observed_at: z.string().datetime().optional(),
  expected_score: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  expected_status: RuntimeEvidenceEvaluatorStatusSchema.optional(),
  expectation_source: z.string().min(1).optional(),
  validation: RuntimeEvidenceEvaluatorValidationSchema.optional(),
  publish_action: RuntimeEvidenceEvaluatorPublishActionSchema.optional(),
  provenance: RuntimeEvidenceEvaluatorProvenanceSchema.optional(),
  summary: z.string().min(1).optional(),
}).strict();
export type RuntimeEvidenceEvaluatorObservation = z.infer<typeof RuntimeEvidenceEvaluatorObservationSchema>;

export const RuntimeEvidenceResearchSourceSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1).optional(),
  source_type: z.enum(["official_docs", "maintainer", "paper", "issue_thread", "example", "writeup", "other"]).default("other"),
  provenance: z.enum(["quoted", "paraphrased", "summarized"]).default("summarized"),
  relevance: z.string().min(1).optional(),
}).strict();
export type RuntimeEvidenceResearchSource = z.infer<typeof RuntimeEvidenceResearchSourceSchema>;

export const RuntimeEvidenceResearchFindingSchema = z.object({
  finding: z.string().min(1),
  source_urls: z.array(z.string().url()).min(1),
  applicability: z.string().min(1),
  risks_constraints: z.array(z.string().min(1)).default([]),
  proposed_experiment: z.string().min(1),
  expected_metric_impact: z.string().min(1),
  fact_vs_adaptation: z.object({
    facts: z.array(z.string().min(1)).default([]),
    adaptation: z.string().min(1),
  }).strict(),
}).strict();
export type RuntimeEvidenceResearchFinding = z.infer<typeof RuntimeEvidenceResearchFindingSchema>;

export const RuntimeEvidenceResearchExternalActionSchema = z.object({
  label: z.string().min(1),
  reason: z.string().min(1),
  approval_required: z.literal(true).default(true),
}).strict();
export type RuntimeEvidenceResearchExternalAction = z.infer<typeof RuntimeEvidenceResearchExternalActionSchema>;

export const RuntimeEvidenceResearchMemoSchema = z.object({
  trigger: z.enum(["plateau", "uncertainty", "knowledge_gap"]),
  query: z.string().min(1),
  summary: z.string().min(1),
  sources: z.array(RuntimeEvidenceResearchSourceSchema).min(1),
  findings: z.array(RuntimeEvidenceResearchFindingSchema).min(1),
  candidate_playbook: z.object({
    title: z.string().min(1),
    steps: z.array(z.string().min(1)).default([]),
    source_urls: z.array(z.string().url()).default([]),
  }).strict().optional(),
  untrusted_content_policy: z.literal("webpage_instructions_are_untrusted").default("webpage_instructions_are_untrusted"),
  external_actions: z.array(RuntimeEvidenceResearchExternalActionSchema).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
}).strict();
export type RuntimeEvidenceResearchMemo = z.infer<typeof RuntimeEvidenceResearchMemoSchema>;

export const RuntimeEvidenceDreamCheckpointTriggerSchema = z.enum([
  "iteration",
  "plateau",
  "breakthrough",
  "pre_finalization",
]);
export type RuntimeEvidenceDreamCheckpointTrigger = z.infer<typeof RuntimeEvidenceDreamCheckpointTriggerSchema>;

export const RuntimeEvidenceDreamCheckpointMemoryRefSchema = z.object({
  source_type: z.enum(["soil", "playbook", "runtime_evidence", "other"]),
  ref: z.string().min(1).optional(),
  summary: z.string().min(1),
  authority: z.literal("advisory_only").default("advisory_only"),
  relevance_score: z.number().min(0).max(1).optional(),
  source_reliability: z.number().min(0).max(1).optional(),
  recency_score: z.number().min(0).max(1).optional(),
  prior_success_contribution: z.number().min(0).max(1).optional(),
  retrieval: z.object({
    kind: z.enum(["route_hit", "fallback_hit", "checkpoint", "manual", "unknown"]).default("unknown"),
    score: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
  }).strict().optional(),
  ranking_trace: z.object({
    score: z.number().min(0).max(1),
    decision: z.enum(["admitted", "rejected"]),
    reason: z.string().min(1),
  }).strict().optional(),
}).strict();
export type RuntimeEvidenceDreamCheckpointMemoryRef = z.infer<typeof RuntimeEvidenceDreamCheckpointMemoryRefSchema>;

export const RuntimeEvidenceDreamCheckpointStrategyCandidateSchema = z.object({
  title: z.string().min(1),
  rationale: z.string().min(1),
  target_dimensions: z.array(z.string().min(1)).default([]),
  expected_evidence_gain: z.string().min(1).optional(),
  retry_reason: z.string().min(1).optional(),
  failed_lineage_warning: z.object({
    fingerprint: z.string().min(1),
    count: z.number().int().positive(),
    reason: z.string().min(1),
  }).strict().optional(),
}).strict();
export type RuntimeEvidenceDreamCheckpointStrategyCandidate = z.infer<typeof RuntimeEvidenceDreamCheckpointStrategyCandidateSchema>;

export const RuntimeEvidenceDreamCheckpointActiveHypothesisSchema = z.object({
  hypothesis: z.string().min(1),
  supporting_evidence_ref: z.string().min(1).optional(),
  target_metric_or_dimension: z.string().min(1),
  expected_next_observation: z.string().min(1),
  status: z.enum(["active", "testing", "supported", "weakened"]).default("active"),
}).strict();
export type RuntimeEvidenceDreamCheckpointActiveHypothesis = z.infer<typeof RuntimeEvidenceDreamCheckpointActiveHypothesisSchema>;

export const RuntimeEvidenceDreamCheckpointRejectedApproachSchema = z.object({
  approach: z.string().min(1),
  rejection_reason: z.string().min(1),
  evidence_ref: z.string().min(1).optional(),
  revisit_condition: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).default(0.5),
}).strict();
export type RuntimeEvidenceDreamCheckpointRejectedApproach = z.infer<typeof RuntimeEvidenceDreamCheckpointRejectedApproachSchema>;

export const RuntimeEvidenceDreamRunControlRecommendationSchema = z.object({
  id: z.string().min(1).optional(),
  action: z.enum([
    "stay_current_mode",
    "widen_exploration",
    "consolidate_candidates",
    "freeze_experiment_queue",
    "enter_finalization",
    "preserve_near_miss_candidates",
    "retire_low_value_lineage",
    "request_operator_approval",
  ]),
  rationale: z.string().min(1),
  evidence: z.array(z.object({
    kind: z.enum(["metric", "artifact", "lineage", "task_history", "deadline", "external_feedback", "memory", "runtime_state"]),
    ref: z.string().min(1).optional(),
    summary: z.string().min(1),
  }).strict()).min(1),
  target_mode: z.enum(["exploration", "consolidation", "finalization"]).optional(),
  target_strategy_family: z.string().min(1).optional(),
  candidate_refs: z.array(z.string().min(1)).default([]),
  lineage_refs: z.array(z.string().min(1)).default([]),
  approval_required: z.boolean().default(false),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
  confidence: z.number().min(0).max(1).default(0.5),
  policy_decision: z.object({
    disposition: z.enum(["auto_apply", "approval_required", "advisory_only"]),
    reason: z.string().min(1),
  }).strict().optional(),
}).strict();
export type RuntimeEvidenceDreamRunControlRecommendation = z.infer<typeof RuntimeEvidenceDreamRunControlRecommendationSchema>;

export const RuntimeEvidenceDreamCheckpointSchema = z.object({
  trigger: RuntimeEvidenceDreamCheckpointTriggerSchema,
  summary: z.string().min(1),
  current_goal: z.string().min(1),
  active_dimensions: z.array(z.string().min(1)).default([]),
  best_evidence_so_far: z.string().min(1).optional(),
  recent_strategy_families: z.array(z.string().min(1)).default([]),
  exhausted: z.array(z.string().min(1)).default([]),
  promising: z.array(z.string().min(1)).default([]),
  relevant_memories: z.array(RuntimeEvidenceDreamCheckpointMemoryRefSchema).default([]),
  active_hypotheses: z.array(RuntimeEvidenceDreamCheckpointActiveHypothesisSchema).default([]),
  rejected_approaches: z.array(RuntimeEvidenceDreamCheckpointRejectedApproachSchema).default([]),
  next_strategy_candidates: z.array(RuntimeEvidenceDreamCheckpointStrategyCandidateSchema).default([]),
  run_control_recommendations: z.array(RuntimeEvidenceDreamRunControlRecommendationSchema).optional(),
  guidance: z.string().min(1),
  uncertainty: z.array(z.string().min(1)).default([]),
  context_authority: z.literal("advisory_only").default("advisory_only"),
  confidence: z.number().min(0).max(1).default(0.5),
}).strict();
export type RuntimeEvidenceDreamCheckpoint = z.infer<typeof RuntimeEvidenceDreamCheckpointSchema>;

export const RuntimeEvidenceDivergentHypothesisSchema = z.object({
  strategy_id: z.string().min(1).optional(),
  hypothesis: z.string().min(1),
  strategy_family: z.string().min(1),
  role: z.enum(["exploitation", "adjacent_exploration", "divergent_exploration"]),
  novelty_score: z.number().min(0).max(1),
  similarity_to_recent_failures: z.number().min(0).max(1).default(0),
  expected_cost: z.enum(["low", "medium", "high"]),
  relationship_to_lineage: z.enum([
    "current_best",
    "neighbor",
    "failed_lineage",
    "different_mechanism",
    "different_assumption",
    "unknown",
  ]),
  prior_evidence: z.string().min(1).optional(),
  downrank_reason: z.string().min(1).optional(),
  smoke_status: z.enum(["not_run", "promote", "defer", "retire"]).default("not_run"),
  smoke_reason: z.string().min(1).optional(),
  smoke_evidence_ref: z.string().min(1).optional(),
  evidence_authority: z.literal("speculative_hypothesis").default("speculative_hypothesis"),
}).strict();
export type RuntimeEvidenceDivergentHypothesis = z.infer<typeof RuntimeEvidenceDivergentHypothesisSchema>;

export const RuntimeEvidenceEntrySchema = z.object({
  schema_version: z.literal("runtime-evidence-entry-v1"),
  id: z.string().min(1),
  occurred_at: z.string().datetime(),
  kind: RuntimeEvidenceEntryKindSchema,
  scope: z.object({
    goal_id: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    loop_index: z.number().int().nonnegative().optional(),
    phase: z.string().min(1).optional(),
  }).strict(),
  hypothesis: z.string().min(1).optional(),
  strategy: z.string().min(1).optional(),
  task: z.object({
    id: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    action: z.string().min(1).optional(),
    primary_dimension: z.string().min(1).optional(),
  }).strict().optional(),
  verification: z.object({
    command: z.string().min(1).optional(),
    verdict: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    summary: z.string().min(1).optional(),
  }).strict().optional(),
  metrics: z.array(RuntimeEvidenceMetricSchema).default([]),
  evaluators: z.array(RuntimeEvidenceEvaluatorObservationSchema).optional(),
  research: z.array(RuntimeEvidenceResearchMemoSchema).optional(),
  dream_checkpoints: z.array(RuntimeEvidenceDreamCheckpointSchema).optional(),
  divergent_exploration: z.array(RuntimeEvidenceDivergentHypothesisSchema).optional(),
  candidates: z.array(RuntimeEvidenceCandidateRecordSchema).optional(),
  artifacts: z.array(RuntimeEvidenceArtifactRefSchema).default([]),
  result: z.object({
    status: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  }).strict().optional(),
  outcome: RuntimeEvidenceOutcomeSchema.optional(),
  decision_reason: z.string().min(1).optional(),
  raw_refs: z.array(z.object({
    kind: z.string().min(1),
    id: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    state_relative_path: z.string().min(1).optional(),
    url: z.string().url().optional(),
  }).strict()).default([]),
  summary: z.string().min(1).optional(),
}).strict().refine((entry) => entry.scope.goal_id || entry.scope.run_id, {
  message: "goal_id or run_id is required",
  path: ["scope"],
});
export type RuntimeEvidenceEntry = z.infer<typeof RuntimeEvidenceEntrySchema>;
export type RuntimeEvidenceEntryInput = Omit<
  RuntimeEvidenceEntry,
  "schema_version" | "id" | "occurred_at" | "metrics" | "evaluators" | "research" | "dream_checkpoints" | "divergent_exploration" | "artifacts" | "raw_refs"
> & Partial<Pick<RuntimeEvidenceEntry, "id" | "occurred_at" | "metrics" | "evaluators" | "research" | "dream_checkpoints" | "divergent_exploration" | "artifacts" | "raw_refs">>;

export interface RuntimeEvidenceReadWarning {
  file: string;
  line: number;
  message: string;
}

export interface RuntimeEvidenceReadResult {
  entries: RuntimeEvidenceEntry[];
  warnings: RuntimeEvidenceReadWarning[];
}

export interface RuntimeFailedLineageContext {
  fingerprint: string;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
  strategy_family?: string;
  hypothesis?: string;
  primary_dimension?: string;
  task_action?: string;
  failure_reason?: string;
  representative_entry_id: string;
  representative_summary: string;
  evidence_entry_ids: string[];
}

export interface RuntimeCandidateLineageContext {
  strategy_family: string;
  candidate_ids: string[];
  retained_representative_ids: string[];
  promoted_ids: string[];
  retired_ids: string[];
  best_candidate_id?: string;
  best_metric?: {
    label: string;
    value: number;
    direction: "maximize" | "minimize";
  };
  diversity_notes: string[];
}

export interface RuntimeCandidatePortfolioSlot {
  candidate_id: string;
  label?: string;
  strategy_family: string;
  role: "top_metric" | "diverse_representative" | "lineage_representative";
  evidence_entry_id: string;
  occurred_at: string;
  metric?: {
    label: string;
    value: number;
    direction: "maximize" | "minimize";
    confidence: number;
  };
  parent_candidate_id?: string;
  source_candidate_id?: string;
  source_strategy_id?: string;
  disposition: RuntimeEvidenceCandidateDisposition;
  retained_reason?: string;
  similarity_to_selected?: RuntimeEvidenceCandidateSimilarity;
}

export interface RuntimeDiversifiedCandidatePortfolioOptions {
  limit?: number;
  nearDuplicateSimilarity?: number;
}

export interface RuntimeCandidateSelectionCandidate {
  candidate_id: string;
  label?: string;
  strategy_family: string;
  evidence_entry_id: string;
  raw_rank: number;
  raw_metric?: {
    label: string;
    value: number;
    direction: "maximize" | "minimize";
    confidence: number;
  };
  robust_score: number;
  metric_score: number;
  stability_score: number;
  diversity_score: number;
  risk_penalty: number;
  evidence_confidence: number;
  reasons: string[];
}

export interface RuntimeCandidateSelectionSummary {
  primary_metric: ComparableMetricKey | null;
  raw_best: RuntimeCandidateSelectionCandidate | null;
  robust_best: RuntimeCandidateSelectionCandidate | null;
  ranked: RuntimeCandidateSelectionCandidate[];
  final_portfolio: {
    safe: RuntimeCandidateSelectionCandidate | null;
    aggressive: RuntimeCandidateSelectionCandidate | null;
    diverse: RuntimeCandidateSelectionCandidate | null;
  };
}

export interface RuntimeEvidenceSummary {
  schema_version: "runtime-evidence-summary-v1";
  generated_at: string;
  scope: {
    goal_id?: string;
    run_id?: string;
  };
  total_entries: number;
  latest_strategy: RuntimeEvidenceEntry | null;
  best_evidence: RuntimeEvidenceEntry | null;
  metric_trends: MetricTrendContext[];
  evaluator_summary: RuntimeEvaluatorSummary;
  research_memos: RuntimeResearchMemoContext[];
  dream_checkpoints: RuntimeDreamCheckpointContext[];
  divergent_exploration: RuntimeEvidenceDivergentHypothesis[];
  candidate_lineages: RuntimeCandidateLineageContext[];
  recommended_candidate_portfolio: RuntimeCandidatePortfolioSlot[];
  candidate_selection_summary: RuntimeCandidateSelectionSummary;
  recent_failed_attempts: RuntimeEvidenceEntry[];
  failed_lineages: RuntimeFailedLineageContext[];
  recent_entries: RuntimeEvidenceEntry[];
  warnings: RuntimeEvidenceReadWarning[];
}

export interface RuntimeEvidenceSummaryIndex {
  schema_version: "runtime-evidence-summary-index-v1";
  generated_at: string;
  canonical_log_path: string;
  canonical_log_size: number;
  canonical_log_mtime_ms: number;
  summary: RuntimeEvidenceSummary;
}

export interface RuntimeEvidenceLedgerPort {
  append(input: RuntimeEvidenceEntryInput): Promise<RuntimeEvidenceEntry[]>;
  readByGoal?(goalId: string): Promise<RuntimeEvidenceReadResult>;
  readByRun?(runId: string): Promise<RuntimeEvidenceReadResult>;
  summarizeGoal?(goalId: string): Promise<RuntimeEvidenceSummary>;
  summarizeRun?(runId: string): Promise<RuntimeEvidenceSummary>;
  rebuildSummaryIndexForGoal?(goalId: string): Promise<RuntimeEvidenceSummary>;
  rebuildSummaryIndexForRun?(runId: string): Promise<RuntimeEvidenceSummary>;
}

export class RuntimeEvidenceLedger implements RuntimeEvidenceLedgerPort {
  private readonly paths: RuntimeStorePaths;

  constructor(runtimeRootOrPaths?: string | RuntimeStorePaths) {
    this.paths =
      typeof runtimeRootOrPaths === "string"
        ? createRuntimeStorePaths(runtimeRootOrPaths)
        : runtimeRootOrPaths ?? createRuntimeStorePaths();
  }

  async ensureReady(): Promise<void> {
    await ensureRuntimeStorePaths(this.paths);
  }

  goalPath(goalId: string): string {
    return this.paths.evidenceGoalPath(goalId);
  }

  runPath(runId: string): string {
    return this.paths.evidenceRunPath(runId);
  }

  async append(input: RuntimeEvidenceEntryInput): Promise<RuntimeEvidenceEntry[]> {
    const entry = RuntimeEvidenceEntrySchema.parse({
      schema_version: "runtime-evidence-entry-v1",
      id: input.id ?? randomUUID(),
      occurred_at: input.occurred_at ?? new Date().toISOString(),
      metrics: input.metrics ?? [],
      evaluators: input.evaluators ?? [],
      research: input.research ?? [],
      dream_checkpoints: input.dream_checkpoints ?? [],
      divergent_exploration: input.divergent_exploration ?? [],
      candidates: input.candidates ?? [],
      artifacts: input.artifacts ?? [],
      raw_refs: input.raw_refs ?? [],
      ...input,
    });
    await this.ensureReady();

    const targets = new Set<string>();
    if (entry.scope.goal_id) targets.add(this.paths.evidenceGoalPath(entry.scope.goal_id));
    if (entry.scope.run_id) targets.add(this.paths.evidenceRunPath(entry.scope.run_id));
    await Promise.all([...targets].map(async (target) => {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.appendFile(target, `${JSON.stringify(entry)}\n`, "utf8");
    }));
    await Promise.all([...targets].map(async (target) => {
      await rebuildSummaryIndex(target);
    }));
    return [entry];
  }

  async readByGoal(goalId: string): Promise<RuntimeEvidenceReadResult> {
    return readEvidenceFile(this.paths.evidenceGoalPath(goalId));
  }

  async readByRun(runId: string): Promise<RuntimeEvidenceReadResult> {
    return readEvidenceFile(this.paths.evidenceRunPath(runId));
  }

  async summarizeGoal(goalId: string): Promise<RuntimeEvidenceSummary> {
    const indexed = await readSummaryIndex(this.paths.evidenceGoalPath(goalId), { goal_id: goalId });
    if (indexed) return indexed.summary;
    const read = await this.readByGoal(goalId);
    const summary = summarizeEvidence({ goal_id: goalId }, read);
    return summary;
  }

  async summarizeRun(runId: string): Promise<RuntimeEvidenceSummary> {
    const indexed = await readSummaryIndex(this.paths.evidenceRunPath(runId), { run_id: runId });
    if (indexed) return indexed.summary;
    const read = await this.readByRun(runId);
    const summary = summarizeEvidence({ run_id: runId }, read);
    return summary;
  }

  async rebuildSummaryIndexForGoal(goalId: string): Promise<RuntimeEvidenceSummary> {
    return rebuildSummaryIndex(this.paths.evidenceGoalPath(goalId));
  }

  async rebuildSummaryIndexForRun(runId: string): Promise<RuntimeEvidenceSummary> {
    return rebuildSummaryIndex(this.paths.evidenceRunPath(runId));
  }
}

async function rebuildSummaryIndex(canonicalPath: string): Promise<RuntimeEvidenceSummary> {
  const scope = summaryScopeFromPath(canonicalPath);
  const read = await readEvidenceFile(canonicalPath);
  const summary = summarizeEvidence(scope, read);
  await writeSummaryIndex(canonicalPath, summary);
  return summary;
}

function summaryIndexPath(canonicalPath: string): string {
  return `${canonicalPath}.summary.json`;
}

function summaryScopeFromPath(canonicalPath: string): RuntimeEvidenceSummary["scope"] {
  const basename = path.basename(canonicalPath, ".jsonl");
  const decoded = decodeURIComponent(basename);
  return canonicalPath.includes(`${path.sep}runs${path.sep}`) ? { run_id: decoded } : { goal_id: decoded };
}

async function readSummaryIndex(
  canonicalPath: string,
  expectedScope: RuntimeEvidenceSummary["scope"]
): Promise<RuntimeEvidenceSummaryIndex | null> {
  let text: string;
  try {
    text = await fsp.readFile(summaryIndexPath(canonicalPath), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(text) as RuntimeEvidenceSummaryIndex;
    if (parsed.schema_version !== "runtime-evidence-summary-index-v1") return null;
    if (parsed.summary.schema_version !== "runtime-evidence-summary-v1") return null;
    if (!isCurrentEvidenceSummaryShape(parsed.summary)) return null;
    const stat = await fsp.stat(canonicalPath);
    if (parsed.canonical_log_size !== stat.size) return null;
    if (parsed.canonical_log_mtime_ms !== stat.mtimeMs) return null;
    if (expectedScope.goal_id && parsed.summary.scope.goal_id !== expectedScope.goal_id) return null;
    if (expectedScope.run_id && parsed.summary.scope.run_id !== expectedScope.run_id) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isCurrentEvidenceSummaryShape(summary: RuntimeEvidenceSummary): boolean {
  return Array.isArray(summary.candidate_lineages)
    && Array.isArray(summary.recommended_candidate_portfolio)
    && typeof summary.candidate_selection_summary === "object"
    && summary.candidate_selection_summary !== null;
}

async function writeSummaryIndex(
  canonicalPath: string,
  summary: RuntimeEvidenceSummary
): Promise<void> {
  const stat = await fsp.stat(canonicalPath);
  const index: RuntimeEvidenceSummaryIndex = {
    schema_version: "runtime-evidence-summary-index-v1",
    generated_at: new Date().toISOString(),
    canonical_log_path: canonicalPath,
    canonical_log_size: stat.size,
    canonical_log_mtime_ms: stat.mtimeMs,
    summary,
  };
  await fsp.mkdir(path.dirname(canonicalPath), { recursive: true });
  await fsp.writeFile(summaryIndexPath(canonicalPath), `${JSON.stringify(index)}\n`, "utf8");
}

async function readEvidenceFile(filePath: string): Promise<RuntimeEvidenceReadResult> {
  let text: string;
  try {
    text = await fsp.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [], warnings: [] };
    }
    throw err;
  }

  const entries: RuntimeEvidenceEntry[] = [];
  const warnings: RuntimeEvidenceReadWarning[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.trim()) continue;
    try {
      const parsed = RuntimeEvidenceEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) {
        entries.push(parsed.data);
      } else {
        warnings.push({
          file: filePath,
          line: index + 1,
          message: parsed.error.issues.map((issue) => issue.message).join("; "),
        });
      }
    } catch (err) {
      warnings.push({
        file: filePath,
        line: index + 1,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { entries, warnings };
}

function summarizeEvidence(
  scope: RuntimeEvidenceSummary["scope"],
  read: RuntimeEvidenceReadResult
): RuntimeEvidenceSummary {
  const entries = [...read.entries].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const newestFirst = [...entries].reverse();
  return {
    schema_version: "runtime-evidence-summary-v1",
    generated_at: new Date().toISOString(),
    scope,
    total_entries: entries.length,
    latest_strategy: newestFirst.find((entry) =>
      entry.kind === "strategy" || Boolean(entry.strategy) || Boolean(entry.decision_reason)
    ) ?? null,
    best_evidence: chooseBestEvidence(newestFirst),
    metric_trends: summarizeEvidenceMetricTrends(entries),
    evaluator_summary: summarizeEvidenceEvaluatorResults(entries),
    research_memos: summarizeEvidenceResearchMemos(entries),
    dream_checkpoints: summarizeEvidenceDreamCheckpoints(entries),
    divergent_exploration: entries
      .flatMap((entry) => entry.divergent_exploration ?? [])
      .slice(-10)
      .reverse(),
    candidate_lineages: summarizeCandidateLineages(entries),
    recommended_candidate_portfolio: selectDiversifiedCandidatePortfolio(entries),
    candidate_selection_summary: summarizeCandidateSelection(entries),
    recent_failed_attempts: newestFirst
      .filter((entry) =>
        entry.outcome === "failed"
        || entry.outcome === "regressed"
        || entry.kind === "failure"
        || entry.result?.status === "failed"
        || entry.verification?.verdict === "fail"
      )
      .slice(0, 5),
    failed_lineages: summarizeFailedLineages(entries),
    recent_entries: newestFirst.slice(0, 10),
    warnings: read.warnings,
  };
}

interface CandidateEvidenceContext {
  entry_id: string;
  occurred_at: string;
  candidate: RuntimeEvidenceCandidateRecord;
  metric: CandidateComparableMetric | null;
}

interface CandidateComparableMetric {
  label: string;
  value: number;
  direction: "maximize" | "minimize";
  confidence: number;
}

export function selectDiversifiedCandidatePortfolio(
  entriesOldestFirst: RuntimeEvidenceEntry[],
  options: RuntimeDiversifiedCandidatePortfolioOptions = {}
): RuntimeCandidatePortfolioSlot[] {
  const limit = options.limit ?? 3;
  if (limit <= 0) return [];
  const nearDuplicateSimilarity = options.nearDuplicateSimilarity ?? 0.85;
  const primaryMetric = resolvePrimaryCandidateMetricKey(entriesOldestFirst);
  const candidates = extractCandidateEvidenceContexts(entriesOldestFirst, primaryMetric)
    .filter((context) => context.candidate.disposition !== "retired")
    .sort(compareCandidateEvidenceContexts);
  const selected: Array<CandidateEvidenceContext & {
    role: RuntimeCandidatePortfolioSlot["role"];
    similarity_to_selected?: RuntimeEvidenceCandidateSimilarity;
  }> = [];
  const skipped: Array<CandidateEvidenceContext & { similarity_to_selected?: RuntimeEvidenceCandidateSimilarity }> = [];

  for (const candidate of candidates) {
    if (selected.length >= limit) break;
    const duplicateSignal = mostSimilarSelectedCandidate(candidate, selected);
    if (duplicateSignal && duplicateSignal.similarity >= nearDuplicateSimilarity) {
      skipped.push({ ...candidate, similarity_to_selected: duplicateSignal });
      continue;
    }
    selected.push({
      ...candidate,
      role: selected.length === 0 ? "top_metric" : "diverse_representative",
      ...(duplicateSignal ? { similarity_to_selected: duplicateSignal } : {}),
    });
  }

  for (const candidate of skipped) {
    if (selected.length >= limit) break;
    selected.push({
      ...candidate,
      role: "lineage_representative",
    });
  }

  return selected.map(toPortfolioSlot);
}

function summarizeCandidateSelection(entriesOldestFirst: RuntimeEvidenceEntry[]): RuntimeCandidateSelectionSummary {
  const primaryMetric = resolvePrimaryCandidateMetricKey(entriesOldestFirst);
  const contexts = extractCandidateEvidenceContexts(entriesOldestFirst, primaryMetric)
    .filter((context) => context.candidate.disposition !== "retired");
  const rawRanked = [...contexts].sort(compareCandidateEvidenceContexts);
  const scored = scoreCandidateSelectionContexts(rawRanked);
  const ranked = [...scored].sort((a, b) => b.robust_score - a.robust_score || a.raw_rank - b.raw_rank);
  const rawBest = scored.find((candidate) => candidate.raw_rank === 1) ?? null;
  const robustBest = ranked[0] ?? null;

  return {
    primary_metric: primaryMetric,
    raw_best: rawBest,
    robust_best: robustBest,
    ranked,
    final_portfolio: {
      safe: selectSafeCandidate(scored),
      aggressive: rawBest,
      diverse: selectDiverseCandidate(scored, robustBest),
    },
  };
}

function scoreCandidateSelectionContexts(
  rawRanked: CandidateEvidenceContext[]
): RuntimeCandidateSelectionCandidate[] {
  const metricValues = rawRanked
    .map((context) => context.metric?.value)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const minMetric = metricValues.length > 0 ? Math.min(...metricValues) : 0;
  const maxMetric = metricValues.length > 0 ? Math.max(...metricValues) : 0;
  const rawBestFamily = rawRanked[0]?.candidate.lineage.strategy_family;
  const allCandidates = rawRanked.map((context) => context.candidate);

  return rawRanked.map((context, index) => {
    const candidate = context.candidate;
    const metricScore = normalizedMetricScore(context.metric, minMetric, maxMetric);
    const stabilityScore = clamp01(candidate.robustness?.stability_score ?? context.metric?.confidence ?? 0.5);
    const inferredDiversity = inferredDiversityScore(candidate, rawBestFamily, allCandidates);
    const diversityScore = clamp01(candidate.robustness?.diversity_score === undefined
      ? inferredDiversity
      : Math.min(candidate.robustness.diversity_score, inferredDiversity));
    const riskPenalty = clamp01(candidate.robustness?.risk_penalty ?? inferredCandidateRiskPenalty(candidate));
    const evidenceConfidence = clamp01(candidate.robustness?.evidence_confidence ?? context.metric?.confidence ?? 0.5);
    const robustScore = clamp01(candidate.robustness?.robust_score
      ?? (metricScore * 0.45 + stabilityScore * 0.3 + diversityScore * 0.15 + evidenceConfidence * 0.1 - riskPenalty));

    return {
      candidate_id: candidate.candidate_id,
      ...(candidate.label ? { label: candidate.label } : {}),
      strategy_family: candidate.lineage.strategy_family,
      evidence_entry_id: context.entry_id,
      raw_rank: index + 1,
      ...(context.metric ? { raw_metric: context.metric } : {}),
      robust_score: roundScore(robustScore),
      metric_score: roundScore(metricScore),
      stability_score: roundScore(stabilityScore),
      diversity_score: roundScore(diversityScore),
      risk_penalty: roundScore(riskPenalty),
      evidence_confidence: roundScore(evidenceConfidence),
      reasons: candidateSelectionReasons(candidate, {
        metricScore,
        stabilityScore,
        diversityScore,
        riskPenalty,
        evidenceConfidence,
      }),
    };
  });
}

function normalizedMetricScore(
  metric: CandidateComparableMetric | null,
  minMetric: number,
  maxMetric: number
): number {
  if (!metric) return 0;
  if (maxMetric === minMetric) return 0.5;
  const distance = metric.direction === "maximize"
    ? (metric.value - minMetric) / (maxMetric - minMetric)
    : (maxMetric - metric.value) / (maxMetric - minMetric);
  return clamp01(distance);
}

function inferredDiversityScore(
  candidate: RuntimeEvidenceCandidateRecord,
  rawBestFamily: string | undefined,
  allCandidates: RuntimeEvidenceCandidateRecord[]
): number {
  if (!rawBestFamily) return 0.5;
  const highestSimilarity = highestKnownSimilarity(candidate, allCandidates);
  const lineageBase = candidate.lineage.strategy_family !== rawBestFamily ? 0.75 : 0.45;
  if (highestSimilarity > 0) return clamp01(Math.min(lineageBase, 1 - highestSimilarity));
  return lineageBase;
}

function highestKnownSimilarity(
  candidate: RuntimeEvidenceCandidateRecord,
  allCandidates: RuntimeEvidenceCandidateRecord[]
): number {
  let highest = candidate.similarity.reduce((max, similarity) => Math.max(max, similarity.similarity), 0);
  for (const other of allCandidates) {
    if (other.candidate_id === candidate.candidate_id) continue;
    for (const similarity of other.similarity) {
      if (similarity.candidate_id === candidate.candidate_id) {
        highest = Math.max(highest, similarity.similarity);
      }
    }
  }
  return highest;
}

function inferredCandidateRiskPenalty(candidate: RuntimeEvidenceCandidateRecord): number {
  const lineageText = [
    ...candidate.lineage.config_lineage,
    ...candidate.lineage.postprocess_lineage,
  ].map(normalizeLineageText).join(" ");
  if (lineageText.includes("manual") || lineageText.includes("threshold") || lineageText.includes("postprocess")) {
    return 0.15;
  }
  if (lineageText.includes("calibration") || lineageText.includes("weight")) {
    return 0.08;
  }
  return 0;
}

function candidateSelectionReasons(
  candidate: RuntimeEvidenceCandidateRecord,
  scores: {
    metricScore: number;
    stabilityScore: number;
    diversityScore: number;
    riskPenalty: number;
    evidenceConfidence: number;
  }
): string[] {
  const reasons: string[] = [];
  if (scores.stabilityScore >= 0.8) reasons.push("strong stability evidence");
  if (scores.diversityScore >= 0.8) reasons.push("diverse lineage");
  if (scores.riskPenalty >= 0.15) reasons.push("penalized for overfit-prone lineage or post-processing");
  if (scores.metricScore >= 0.95) reasons.push("top raw metric evidence");
  if (candidate.robustness?.summary) reasons.push(candidate.robustness.summary);
  return reasons.length > 0 ? reasons : ["risk-adjusted candidate evidence"];
}

function selectSafeCandidate(
  candidates: RuntimeCandidateSelectionCandidate[]
): RuntimeCandidateSelectionCandidate | null {
  return [...candidates].sort((a, b) =>
    b.stability_score - a.stability_score
    || a.risk_penalty - b.risk_penalty
    || b.robust_score - a.robust_score
    || a.raw_rank - b.raw_rank
  )[0] ?? null;
}

function selectDiverseCandidate(
  candidates: RuntimeCandidateSelectionCandidate[],
  robustBest: RuntimeCandidateSelectionCandidate | null
): RuntimeCandidateSelectionCandidate | null {
  const robustFamily = robustBest?.strategy_family;
  return [...candidates]
    .filter((candidate) => !robustFamily || candidate.strategy_family !== robustFamily)
    .filter((candidate) => candidate.diversity_score >= 0.5)
    .sort((a, b) =>
      b.diversity_score - a.diversity_score
      || b.robust_score - a.robust_score
      || a.raw_rank - b.raw_rank
    )[0] ?? null;
}

function summarizeCandidateLineages(entriesOldestFirst: RuntimeEvidenceEntry[]): RuntimeCandidateLineageContext[] {
  const primaryMetric = resolvePrimaryCandidateMetricKey(entriesOldestFirst);
  const byFamily = new Map<string, CandidateEvidenceContext[]>();
  for (const context of extractCandidateEvidenceContexts(entriesOldestFirst, primaryMetric)) {
    const family = context.candidate.lineage.strategy_family;
    byFamily.set(family, [...(byFamily.get(family) ?? []), context]);
  }

  return [...byFamily.entries()]
    .map(([strategyFamily, contexts]) => {
      const sorted = [...contexts].sort(compareCandidateEvidenceContexts);
      const best = sorted[0];
      const diversityNotes = new Set<string>();
      for (const context of contexts) {
        for (const similarity of context.candidate.similarity) {
          if (similarity.similarity >= 0.85) {
            diversityNotes.add(`${context.candidate.candidate_id} near-duplicate of ${similarity.candidate_id}`);
          }
        }
      }
      return {
        strategy_family: strategyFamily,
        candidate_ids: contexts.map((context) => context.candidate.candidate_id),
        retained_representative_ids: sorted
          .filter((context) => context.candidate.disposition === "retained" || context.candidate.disposition === "promoted")
          .map((context) => context.candidate.candidate_id)
          .slice(0, 3),
        promoted_ids: contexts
          .filter((context) => context.candidate.disposition === "promoted")
          .map((context) => context.candidate.candidate_id),
        retired_ids: contexts
          .filter((context) => context.candidate.disposition === "retired")
          .map((context) => context.candidate.candidate_id),
        ...(best ? { best_candidate_id: best.candidate.candidate_id } : {}),
        ...(best?.metric
          ? {
              best_metric: {
                label: best.metric.label,
                value: best.metric.value,
                direction: best.metric.direction,
              },
            }
          : {}),
        diversity_notes: [...diversityNotes].slice(0, 5),
      } satisfies RuntimeCandidateLineageContext;
    })
    .sort((a, b) => {
      const aMetric = a.best_metric;
      const bMetric = b.best_metric;
      if (aMetric && bMetric && aMetric.direction === bMetric.direction) {
        const delta = aMetric.direction === "maximize" ? bMetric.value - aMetric.value : aMetric.value - bMetric.value;
        if (delta !== 0) return delta;
      }
      if (aMetric && !bMetric) return -1;
      if (!aMetric && bMetric) return 1;
      return a.strategy_family.localeCompare(b.strategy_family);
    });
}

function extractCandidateEvidenceContexts(
  entriesOldestFirst: RuntimeEvidenceEntry[],
  primaryMetric: ComparableMetricKey | null
): CandidateEvidenceContext[] {
  const contexts: CandidateEvidenceContext[] = [];
  for (const entry of entriesOldestFirst) {
    for (const candidate of entry.candidates ?? []) {
      contexts.push({
        entry_id: entry.id,
        occurred_at: candidate.produced_at ?? entry.occurred_at,
        candidate,
        metric: candidateComparableMetric(candidate, primaryMetric),
      });
    }
  }
  return contexts;
}

function resolvePrimaryCandidateMetricKey(entriesOldestFirst: RuntimeEvidenceEntry[]): ComparableMetricKey | null {
  const candidates = entriesOldestFirst.flatMap((entry) => entry.candidates ?? []);
  const byMetric = new Map<string, {
    key: ComparableMetricKey;
    candidate_count: number;
    position_sum: number;
    latest_index: number;
  }>();

  candidates.forEach((candidate, candidateIndex) => {
    const seenForCandidate = new Set<string>();
    candidate.metrics.forEach((metric, metricIndex) => {
      if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) return;
      if (metric.direction !== "maximize" && metric.direction !== "minimize") return;
      const key = { label: metric.label, direction: metric.direction };
      const mapKey = `${key.label}:${key.direction}`;
      if (seenForCandidate.has(mapKey)) return;
      seenForCandidate.add(mapKey);
      const existing = byMetric.get(mapKey);
      if (!existing) {
        byMetric.set(mapKey, {
          key,
          candidate_count: 1,
          position_sum: metricIndex,
          latest_index: candidateIndex,
        });
        return;
      }
      existing.candidate_count += 1;
      existing.position_sum += metricIndex;
      existing.latest_index = candidateIndex;
    });
  });

  return [...byMetric.values()].sort((a, b) => {
    const coverageDelta = b.candidate_count - a.candidate_count;
    if (coverageDelta !== 0) return coverageDelta;
    const localityDelta = Number(isLocalValidationMetricLabel(b.key.label)) - Number(isLocalValidationMetricLabel(a.key.label));
    if (localityDelta !== 0) return localityDelta;
    const positionDelta = a.position_sum / a.candidate_count - b.position_sum / b.candidate_count;
    if (positionDelta !== 0) return positionDelta;
    return b.latest_index - a.latest_index;
  })[0]?.key ?? null;
}

function isLocalValidationMetricLabel(label: string): boolean {
  const normalized = normalizeLineageText(label);
  const externalHints = ["public", "private", "leaderboard", "external", "lb", "submission"];
  for (const hint of externalHints) {
    if (normalized === hint || normalized.includes(hint)) {
      return false;
    }
  }
  return true;
}

function candidateComparableMetric(
  candidate: RuntimeEvidenceCandidateRecord,
  primaryMetric: ComparableMetricKey | null
): CandidateComparableMetric | null {
  for (const metric of candidate.metrics) {
    if (primaryMetric && (metric.label !== primaryMetric.label || metric.direction !== primaryMetric.direction)) continue;
    if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) continue;
    if (metric.direction !== "maximize" && metric.direction !== "minimize") continue;
    return {
      label: metric.label,
      value: metric.value,
      direction: metric.direction,
      confidence: metric.confidence ?? 1,
    };
  }
  return null;
}

function compareCandidateEvidenceContexts(a: CandidateEvidenceContext, b: CandidateEvidenceContext): number {
  const metricDelta = compareCandidateMetrics(a.metric, b.metric);
  if (metricDelta !== 0) return metricDelta;
  const dispositionDelta = dispositionRank(b.candidate.disposition) - dispositionRank(a.candidate.disposition);
  if (dispositionDelta !== 0) return dispositionDelta;
  const confidenceDelta = (b.metric?.confidence ?? 0) - (a.metric?.confidence ?? 0);
  if (confidenceDelta !== 0) return confidenceDelta;
  return b.occurred_at.localeCompare(a.occurred_at);
}

function compareCandidateMetrics(a: CandidateComparableMetric | null, b: CandidateComparableMetric | null): number {
  if (a && b && a.direction === b.direction) {
    const valueDelta = a.direction === "maximize" ? b.value - a.value : a.value - b.value;
    if (valueDelta !== 0) return valueDelta;
  }
  if (a && !b) return -1;
  if (!a && b) return 1;
  return 0;
}

function dispositionRank(disposition: RuntimeEvidenceCandidateDisposition): number {
  if (disposition === "promoted") return 2;
  if (disposition === "retained") return 1;
  return 0;
}

function mostSimilarSelectedCandidate(
  candidate: CandidateEvidenceContext,
  selected: CandidateEvidenceContext[]
): RuntimeEvidenceCandidateSimilarity | undefined {
  let best: RuntimeEvidenceCandidateSimilarity | undefined;
  for (const selectedCandidate of selected) {
    const similarity = similarityBetweenCandidates(candidate.candidate, selectedCandidate.candidate);
    if (!similarity) continue;
    if (!best || similarity.similarity > best.similarity) best = similarity;
  }
  return best;
}

function similarityBetweenCandidates(
  candidate: RuntimeEvidenceCandidateRecord,
  selected: RuntimeEvidenceCandidateRecord
): RuntimeEvidenceCandidateSimilarity | undefined {
  const direct = candidate.similarity.find((similarity) => similarity.candidate_id === selected.candidate_id);
  const inverse = selected.similarity.find((similarity) => similarity.candidate_id === candidate.candidate_id);
  if (direct && inverse) return direct.similarity >= inverse.similarity ? direct : inverse;
  if (direct) return direct;
  if (inverse) {
    return {
      ...inverse,
      candidate_id: selected.candidate_id,
    };
  }
  if (
    candidate.lineage.strategy_family === selected.lineage.strategy_family
    && candidateLineageFingerprint(candidate) === candidateLineageFingerprint(selected)
  ) {
    return {
      candidate_id: selected.candidate_id,
      similarity: 0.9,
      signal: "lineage",
      summary: "candidate shares strategy family and lineage fingerprint",
    };
  }
  return undefined;
}

function candidateLineageFingerprint(candidate: RuntimeEvidenceCandidateRecord): string {
  const lineage = candidate.lineage;
  return [
    lineage.strategy_family,
    ...lineage.feature_lineage,
    ...lineage.model_lineage,
    ...lineage.config_lineage,
    ...lineage.postprocess_lineage,
  ].map(normalizeLineageText).filter(Boolean).join("|");
}

function toPortfolioSlot(
  context: CandidateEvidenceContext & {
    role: RuntimeCandidatePortfolioSlot["role"];
    similarity_to_selected?: RuntimeEvidenceCandidateSimilarity;
  }
): RuntimeCandidatePortfolioSlot {
  const candidate = context.candidate;
  return {
    candidate_id: candidate.candidate_id,
    ...(candidate.label ? { label: candidate.label } : {}),
    strategy_family: candidate.lineage.strategy_family,
    role: context.role,
    evidence_entry_id: context.entry_id,
    occurred_at: context.occurred_at,
    ...(context.metric ? { metric: context.metric } : {}),
    ...(candidate.lineage.parent_candidate_id ? { parent_candidate_id: candidate.lineage.parent_candidate_id } : {}),
    ...(candidate.lineage.source_candidate_id ? { source_candidate_id: candidate.lineage.source_candidate_id } : {}),
    ...(candidate.lineage.source_strategy_id ? { source_strategy_id: candidate.lineage.source_strategy_id } : {}),
    disposition: candidate.disposition,
    ...(candidate.disposition_reason ? { retained_reason: candidate.disposition_reason } : {}),
    ...(context.similarity_to_selected ? { similarity_to_selected: context.similarity_to_selected } : {}),
  };
}

function summarizeFailedLineages(entriesOldestFirst: RuntimeEvidenceEntry[]): RuntimeFailedLineageContext[] {
  const lineages = new Map<string, RuntimeFailedLineageContext>();
  for (const entry of entriesOldestFirst) {
    if (!isFailedEvidenceEntry(entry)) continue;
    const fingerprintInput = failedLineageFingerprintInput(entry);
    const normalizedIdentityParts = [
      normalizeLineageText(fingerprintInput.strategy_family),
      normalizeLineageText(fingerprintInput.hypothesis),
      normalizeLineageText(fingerprintInput.primary_dimension),
      normalizeLineageText(fingerprintInput.task_action),
    ].filter(Boolean);
    const normalizedFallbackParts = [normalizeLineageText(fingerprintInput.failure_reason)].filter(Boolean);
    const fingerprintParts = normalizedIdentityParts.length > 0 ? normalizedIdentityParts : normalizedFallbackParts;
    if (fingerprintParts.length === 0) continue;
    const fingerprint = fingerprintParts.join("|");
    const summary = entry.summary
      ?? entry.result?.summary
      ?? entry.verification?.summary
      ?? entry.result?.error
      ?? `${entry.kind} failed`;
    const existing = lineages.get(fingerprint);
    if (!existing) {
      lineages.set(fingerprint, {
        fingerprint,
        count: 1,
        first_seen_at: entry.occurred_at,
        last_seen_at: entry.occurred_at,
        ...(fingerprintInput.strategy_family ? { strategy_family: fingerprintInput.strategy_family } : {}),
        ...(fingerprintInput.hypothesis ? { hypothesis: fingerprintInput.hypothesis } : {}),
        ...(fingerprintInput.primary_dimension ? { primary_dimension: fingerprintInput.primary_dimension } : {}),
        ...(fingerprintInput.task_action ? { task_action: fingerprintInput.task_action } : {}),
        ...(fingerprintInput.failure_reason ? { failure_reason: fingerprintInput.failure_reason } : {}),
        representative_entry_id: entry.id,
        representative_summary: summary,
        evidence_entry_ids: [entry.id],
      });
      continue;
    }
    existing.count += 1;
    existing.last_seen_at = entry.occurred_at;
    existing.representative_entry_id = entry.id;
    existing.representative_summary = summary;
    existing.evidence_entry_ids = [...existing.evidence_entry_ids, entry.id].slice(-5);
  }

  return [...lineages.values()]
    .sort((a, b) => b.count - a.count || b.last_seen_at.localeCompare(a.last_seen_at))
    .slice(0, 10);
}

function isFailedEvidenceEntry(entry: RuntimeEvidenceEntry): boolean {
  return entry.outcome === "failed"
    || entry.outcome === "regressed"
    || entry.kind === "failure"
    || entry.result?.status === "failed"
    || entry.verification?.verdict === "fail";
}

function failedLineageFingerprintInput(entry: RuntimeEvidenceEntry): {
  strategy_family?: string;
  hypothesis?: string;
  primary_dimension?: string;
  task_action?: string;
  failure_reason?: string;
} {
  const strategyFamily = entry.strategy ?? entry.task?.action;
  return {
    ...(strategyFamily ? { strategy_family: strategyFamily } : {}),
    ...(entry.hypothesis ? { hypothesis: entry.hypothesis } : {}),
    ...(entry.task?.primary_dimension ? { primary_dimension: entry.task.primary_dimension } : {}),
    ...(entry.task?.action ? { task_action: entry.task.action } : {}),
    ...(entry.result?.error || entry.result?.summary || entry.verification?.summary
      ? { failure_reason: entry.result?.error ?? entry.result?.summary ?? entry.verification?.summary }
      : {}),
  };
}

function normalizeLineageText(value: string | undefined): string {
  return value?.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, " ").trim() ?? "";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function chooseBestEvidence(entriesNewestFirst: RuntimeEvidenceEntry[]): RuntimeEvidenceEntry | null {
  const metricBest = chooseBestMetricEvidence(entriesNewestFirst);
  if (metricBest) return metricBest;

  return chooseBestFallbackEvidence(entriesNewestFirst);
}

function chooseBestFallbackEvidence(entriesNewestFirst: RuntimeEvidenceEntry[]): RuntimeEvidenceEntry | null {
  return entriesNewestFirst.find((entry) => entry.outcome === "improved")
    ?? entriesNewestFirst.find((entry) => entry.verification?.verdict === "pass")
    ?? entriesNewestFirst.find((entry) => entry.metrics.length > 0)
    ?? entriesNewestFirst.find((entry) => entry.kind === "artifact")
    ?? null;
}

interface ComparableEvidenceMetric {
  entry: RuntimeEvidenceEntry;
  metric: RuntimeEvidenceMetric;
  value: number;
  direction: "maximize" | "minimize";
  primary_metric: ComparableMetricKey;
  improvement_strength: number;
  confidence: number;
  has_pass_verification: boolean;
  has_artifact: boolean;
}

interface ComparableMetricKey {
  label: string;
  direction: "maximize" | "minimize";
}

function chooseBestMetricEvidence(entriesNewestFirst: RuntimeEvidenceEntry[]): RuntimeEvidenceEntry | null {
  const primaryMetric = resolvePrimaryMetricKey(entriesNewestFirst);
  if (!primaryMetric) return null;

  const oldestFirst = [...entriesNewestFirst].reverse();
  const baseline = findComparableMetric(oldestFirst, primaryMetric)?.value;
  const candidates = entriesNewestFirst
    .map((entry) => {
      const metric = findComparableMetric([entry], primaryMetric);
      if (!metric) return null;
      return {
        entry,
        metric: metric.metric,
        value: metric.value,
        direction: metric.direction,
        primary_metric: primaryMetric,
        improvement_strength: baseline === undefined
          ? 0
          : metric.direction === "maximize"
            ? metric.value - baseline
            : baseline - metric.value,
        confidence: metric.metric.confidence ?? entry.verification?.confidence ?? 1,
        has_pass_verification: entry.verification?.verdict === "pass",
        has_artifact: entry.artifacts.length > 0 || entry.kind === "artifact",
      } satisfies ComparableEvidenceMetric;
    })
    .filter((candidate): candidate is ComparableEvidenceMetric => Boolean(candidate));

  if (candidates.length === 0) return null;
  return candidates.sort(compareComparableEvidenceMetrics)[0]?.entry ?? null;
}

function resolvePrimaryMetricKey(entriesNewestFirst: RuntimeEvidenceEntry[]): ComparableMetricKey | null {
  for (const entry of entriesNewestFirst) {
    const metric = findFirstDirectedNumericMetric(entry);
    if (metric?.direction === "maximize" || metric?.direction === "minimize") {
      return { label: metric.label, direction: metric.direction };
    }
  }
  return null;
}

function findComparableMetric(
  entries: RuntimeEvidenceEntry[],
  key: ComparableMetricKey
): { metric: RuntimeEvidenceMetric; value: number; direction: "maximize" | "minimize" } | null {
  for (const entry of entries) {
    for (const metric of entry.metrics) {
      if (metric.label !== key.label || metric.direction !== key.direction) continue;
      const comparable = toComparableMetric(metric);
      if (comparable) return comparable;
    }
  }
  return null;
}

function findFirstDirectedNumericMetric(entry: RuntimeEvidenceEntry): RuntimeEvidenceMetric | null {
  for (const metric of entry.metrics) {
    if (toComparableMetric(metric)) return metric;
  }
  return null;
}

function toComparableMetric(
  metric: RuntimeEvidenceMetric
): { metric: RuntimeEvidenceMetric; value: number; direction: "maximize" | "minimize" } | null {
  if (typeof metric.value !== "number" || !Number.isFinite(metric.value)) return null;
  if (metric.direction !== "maximize" && metric.direction !== "minimize") return null;
  return {
    metric,
    value: metric.value,
    direction: metric.direction,
  };
}

function compareComparableEvidenceMetrics(a: ComparableEvidenceMetric, b: ComparableEvidenceMetric): number {
  const direction = a.direction;
  const valueDelta = direction === "maximize" ? b.value - a.value : a.value - b.value;
  if (valueDelta !== 0) return valueDelta;

  const passDelta = Number(b.has_pass_verification) - Number(a.has_pass_verification);
  if (passDelta !== 0) return passDelta;

  const artifactDelta = Number(b.has_artifact) - Number(a.has_artifact);
  if (artifactDelta !== 0) return artifactDelta;

  const confidenceDelta = b.confidence - a.confidence;
  if (confidenceDelta !== 0) return confidenceDelta;

  const improvementDelta = b.improvement_strength - a.improvement_strength;
  if (improvementDelta !== 0) return improvementDelta;

  return b.entry.occurred_at.localeCompare(a.entry.occurred_at);
}
