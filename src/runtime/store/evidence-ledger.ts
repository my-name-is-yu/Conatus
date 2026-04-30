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
  "schema_version" | "id" | "occurred_at" | "metrics" | "artifacts" | "raw_refs"
> & Partial<Pick<RuntimeEvidenceEntry, "id" | "occurred_at" | "metrics" | "artifacts" | "raw_refs">>;

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
