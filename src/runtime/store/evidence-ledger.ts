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
}).strict();
export type RuntimeEvidenceDreamCheckpointMemoryRef = z.infer<typeof RuntimeEvidenceDreamCheckpointMemoryRefSchema>;

export const RuntimeEvidenceDreamCheckpointStrategyCandidateSchema = z.object({
  title: z.string().min(1),
  rationale: z.string().min(1),
  target_dimensions: z.array(z.string().min(1)).default([]),
  expected_evidence_gain: z.string().min(1).optional(),
}).strict();
export type RuntimeEvidenceDreamCheckpointStrategyCandidate = z.infer<typeof RuntimeEvidenceDreamCheckpointStrategyCandidateSchema>;

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
  recent_failed_attempts: RuntimeEvidenceEntry[];
  recent_entries: RuntimeEvidenceEntry[];
  warnings: RuntimeEvidenceReadWarning[];
}

export interface RuntimeEvidenceLedgerPort {
  append(input: RuntimeEvidenceEntryInput): Promise<RuntimeEvidenceEntry[]>;
  readByGoal?(goalId: string): Promise<RuntimeEvidenceReadResult>;
  readByRun?(runId: string): Promise<RuntimeEvidenceReadResult>;
  summarizeGoal?(goalId: string): Promise<RuntimeEvidenceSummary>;
  summarizeRun?(runId: string): Promise<RuntimeEvidenceSummary>;
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
    return [entry];
  }

  async readByGoal(goalId: string): Promise<RuntimeEvidenceReadResult> {
    return readEvidenceFile(this.paths.evidenceGoalPath(goalId));
  }

  async readByRun(runId: string): Promise<RuntimeEvidenceReadResult> {
    return readEvidenceFile(this.paths.evidenceRunPath(runId));
  }

  async summarizeGoal(goalId: string): Promise<RuntimeEvidenceSummary> {
    const read = await this.readByGoal(goalId);
    return summarizeEvidence({ goal_id: goalId }, read);
  }

  async summarizeRun(runId: string): Promise<RuntimeEvidenceSummary> {
    const read = await this.readByRun(runId);
    return summarizeEvidence({ run_id: runId }, read);
  }
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
    recent_failed_attempts: newestFirst
      .filter((entry) =>
        entry.outcome === "failed"
        || entry.outcome === "regressed"
        || entry.kind === "failure"
        || entry.result?.status === "failed"
        || entry.verification?.verdict === "fail"
      )
      .slice(0, 5),
    recent_entries: newestFirst.slice(0, 10),
    warnings: read.warnings,
  };
}

function chooseBestEvidence(entriesNewestFirst: RuntimeEvidenceEntry[]): RuntimeEvidenceEntry | null {
  return entriesNewestFirst.find((entry) => entry.outcome === "improved")
    ?? entriesNewestFirst.find((entry) => entry.verification?.verdict === "pass")
    ?? entriesNewestFirst.find((entry) => entry.metrics.length > 0)
    ?? entriesNewestFirst.find((entry) => entry.kind === "artifact")
    ?? null;
}
