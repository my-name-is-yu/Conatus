import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  answerRuntimeEvidenceQuestion,
  buildRuntimeEvidenceAnswer,
  recognizeRuntimeEvidenceQuestion,
} from "../evidence-answer.js";
import type { BackgroundRun } from "../session-registry/types.js";
import { BackgroundRunLedger } from "../store/background-run-store.js";
import { RuntimeEvidenceLedger, type RuntimeEvidenceSummary } from "../store/evidence-ledger.js";

const NOW = new Date("2026-05-02T00:30:00.000Z");

function run(overrides: Partial<BackgroundRun> = {}): BackgroundRun {
  return {
    schema_version: "background-run-v1",
    id: "run-1",
    kind: "coreloop_run",
    parent_session_id: null,
    child_session_id: null,
    process_session_id: null,
    status: "running",
    notify_policy: "done_only",
    reply_target_source: "none",
    pinned_reply_target: null,
    title: "Kaggle run",
    workspace: "/repo",
    created_at: "2026-05-02T00:00:00.000Z",
    started_at: "2026-05-02T00:00:00.000Z",
    updated_at: "2026-05-02T00:25:00.000Z",
    completed_at: null,
    summary: null,
    error: null,
    artifacts: [],
    source_refs: [],
    ...overrides,
  };
}

function summary(overrides: Partial<RuntimeEvidenceSummary> = {}): RuntimeEvidenceSummary {
  return {
    schema_version: "runtime-evidence-summary-v1",
    generated_at: "2026-05-02T00:25:00.000Z",
    scope: { run_id: "run-1" },
    total_entries: 1,
    latest_strategy: null,
    best_evidence: null,
    metric_trends: [],
    evaluator_summary: {
      local_best: null,
      external_best: null,
      gap: null,
      budgets: [],
      calibration: [],
      approval_required_actions: [],
      observations: [],
    },
    research_memos: [],
    dream_checkpoints: [],
    divergent_exploration: [],
    candidate_lineages: [],
    recommended_candidate_portfolio: [],
    candidate_selection_summary: {
      primary_metric: null,
      raw_best: null,
      robust_best: null,
      ranked: [],
      final_portfolio: {
        safe: null,
        aggressive: null,
        diverse: null,
      },
    },
    near_miss_candidates: [],
    artifact_retention: {
      schema_version: "runtime-artifact-retention-summary-v1",
      total_artifacts: 0,
      total_size_bytes: 0,
      unknown_size_count: 0,
      protected_count: 0,
      by_retention_class: {
        final_deliverable: 0,
        best_candidate: 0,
        robust_candidate: 0,
        near_miss: 0,
        reproducibility_critical: 0,
        evidence_report: 0,
        low_value_smoke: 0,
        cache_intermediate: 0,
        duplicate_superseded: 0,
        other: 0,
      },
      cleanup_plan: {
        mode: "plan_only",
        destructive_actions_default: "approval_required",
        actions: [],
      },
    },
    recent_failed_attempts: [],
    failed_lineages: [],
    recent_entries: [],
    warnings: [],
    ...overrides,
  };
}

describe("recognizeRuntimeEvidenceQuestion", () => {
  it("recognizes evidence questions without treating long-run start requests as questions", () => {
    expect(recognizeRuntimeEvidenceQuestion("Progress?")).toContain("progress");
    expect(recognizeRuntimeEvidenceQuestion("What strategy is it trying now?")).toContain("strategy");
    expect(recognizeRuntimeEvidenceQuestion("Which artifact is best?")).toEqual(expect.arrayContaining(["metric", "artifact"]));
    expect(recognizeRuntimeEvidenceQuestion("Run this Kaggle competition until tomorrow morning")).toEqual([]);
  });
});

describe("buildRuntimeEvidenceAnswer", () => {
  it("answers progress and cumulative best metric from persisted runtime evidence", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-evidence-answer-"));
    const ledger = new RuntimeEvidenceLedger(path.join(tmp, "runtime"));
    await ledger.append({
      kind: "metric",
      scope: { run_id: "run-1" },
      occurred_at: "2026-05-02T00:00:00.000Z",
      metrics: [{ label: "balanced_accuracy", value: 0.82, direction: "maximize", observed_at: "2026-05-02T00:00:00.000Z" }],
      summary: "baseline scored",
    });
    await ledger.append({
      kind: "metric",
      scope: { run_id: "run-1" },
      occurred_at: "2026-05-02T00:20:00.000Z",
      metrics: [{ label: "balanced_accuracy", value: 0.91, direction: "maximize", observed_at: "2026-05-02T00:20:00.000Z" }],
      summary: "new candidate scored",
    });

    const result = buildRuntimeEvidenceAnswer({
      text: "Progress and best metric?",
      topics: ["progress", "metric"],
      snapshot: null,
      health: null,
      run: run(),
      summary: await ledger.summarizeRun("run-1"),
      now: NOW,
    });

    expect(result.kind).toBe("answered");
    expect(result.message).toContain("balanced_accuracy");
    expect(result.message).toContain("cumulative best 0.91");
    expect(result.message).toContain("breakthrough");
  });

  it("answers artifact and candidate questions without leaking secrets", () => {
    const result = buildRuntimeEvidenceAnswer({
      text: "Which artifact is best?",
      topics: ["artifact"],
      snapshot: null,
      health: null,
      run: run({
        artifacts: [{ label: "report", path: "/repo/report.md?token=secret-token-value", url: null, kind: "report" }],
      }),
      summary: summary({
        recommended_candidate_portfolio: [{
          candidate_id: "candidate-a",
          label: "Candidate A",
          strategy_family: "tabular-ensemble",
          role: "top_metric",
          evidence_entry_id: "entry-1",
          occurred_at: "2026-05-02T00:20:00.000Z",
          metric: {
            label: "balanced_accuracy",
            value: 0.91,
            direction: "maximize",
            confidence: 1,
          },
          disposition: "retained",
        }],
      }),
      now: NOW,
    });

    expect(result.message).toContain("report: /repo/report.md?token=[REDACTED]");
    expect(result.message).toContain("Candidate A");
    expect(result.message).not.toContain("secret-token-value");
  });

  it("answers strategy questions from strategy and Dream checkpoint evidence", () => {
    const strategy = {
      schema_version: "runtime-evidence-entry-v1" as const,
      id: "entry-strategy",
      occurred_at: "2026-05-02T00:10:00.000Z",
      kind: "strategy" as const,
      scope: { run_id: "run-1" },
      metrics: [],
      artifacts: [],
      raw_refs: [],
      summary: "Testing calibrated ensemble features.",
    };
    const result = buildRuntimeEvidenceAnswer({
      text: "What strategy is it trying now?",
      topics: ["strategy"],
      snapshot: null,
      health: null,
      run: run(),
      summary: summary({
        latest_strategy: strategy,
        dream_checkpoints: [{
          entry_id: "entry-dream",
          occurred_at: "2026-05-02T00:20:00.000Z",
          trigger: "plateau",
          summary: "Plateau suggests shifting to a diversified ensemble.",
          current_goal: "Improve Kaggle score",
          active_dimensions: ["balanced_accuracy"],
          recent_strategy_families: ["feature-search"],
          exhausted: [],
          promising: ["ensemble"],
          relevant_memories: [],
          active_hypotheses: [{
            hypothesis: "Class recall imbalance is limiting the score.",
            target_metric_or_dimension: "balanced_accuracy",
            expected_next_observation: "minority recall improves",
            status: "testing",
          }],
          rejected_approaches: [],
          next_strategy_candidates: [{
            title: "Blend calibrated candidates",
            rationale: "Reduce variance across folds.",
            target_dimensions: ["balanced_accuracy"],
          }],
          guidance: "Try the ensemble next.",
          uncertainty: [],
          context_authority: "advisory_only",
          confidence: 0.8,
        }],
      }),
      now: NOW,
    });

    expect(result.message).toContain("Testing calibrated ensemble features");
    expect(result.message).toContain("Blend calibrated candidates");
    expect(result.message).toContain("Class recall imbalance");
  });

  it("marks stale evidence explicitly", () => {
    const result = buildRuntimeEvidenceAnswer({
      text: "Status?",
      topics: ["progress"],
      snapshot: null,
      health: null,
      run: run(),
      summary: summary({
        generated_at: "2026-05-01T22:00:00.000Z",
        recent_entries: [{
          schema_version: "runtime-evidence-entry-v1",
          id: "entry-old",
          occurred_at: "2026-05-01T22:00:00.000Z",
          kind: "observation",
          scope: { run_id: "run-1" },
          metrics: [],
          artifacts: [],
          raw_refs: [],
          summary: "old status",
        }],
      }),
      now: NOW,
    });

    expect(result.messageType).toBe("warning");
    expect(result.message).toContain("Evidence may be stale");
    expect(result.message).toContain("Latest evidence may be stale");
  });

  it("answers missing evidence cases instead of falling back to model memory", () => {
    const result = buildRuntimeEvidenceAnswer({
      text: "Progress?",
      topics: ["progress"],
      snapshot: null,
      health: null,
      run: run(),
      summary: null,
      now: NOW,
    });

    expect(result.messageType).toBe("warning");
    expect(result.message).toContain("Evidence missing");
  });

  it("keeps the highest-priority active run selected even when only an older run has evidence", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-evidence-active-run-"));
    const stateManager = { getBaseDir: () => tmp };
    const ledger = new RuntimeEvidenceLedger(path.join(tmp, "runtime"));
    const runLedger = new BackgroundRunLedger(path.join(tmp, "runtime"));
    await ledger.append({
      kind: "metric",
      scope: { run_id: "run-old" },
      occurred_at: "2026-05-02T00:00:00.000Z",
      metrics: [{ label: "score", value: 0.9, direction: "maximize", observed_at: "2026-05-02T00:00:00.000Z" }],
      summary: "older completed run evidence",
    });
    await runLedger.create({
      id: "run-old",
      kind: "coreloop_run",
      status: "running",
      notify_policy: "silent",
      title: "Old run",
      workspace: "/repo",
      created_at: "2026-05-01T00:00:00.000Z",
      started_at: "2026-05-01T00:00:00.000Z",
      updated_at: "2026-05-01T01:00:00.000Z",
    });
    await runLedger.terminal("run-old", {
      status: "succeeded",
        completed_at: "2026-05-01T01:00:00.000Z",
      updated_at: "2026-05-01T01:00:00.000Z",
      summary: "old run",
    });
    await runLedger.create({
      id: "run-active",
      kind: "coreloop_run",
      status: "running",
      notify_policy: "silent",
      title: "Active run",
      workspace: "/repo",
      created_at: "2026-05-02T00:00:00.000Z",
      started_at: "2026-05-02T00:00:00.000Z",
      updated_at: "2026-05-02T00:25:00.000Z",
      summary: "active run",
    });

    const result = await answerRuntimeEvidenceQuestion({
      text: "Progress?",
      stateManager,
      now: NOW,
    });

    expect(result.kind).toBe("answered");
    expect(result.targetRunId).toBe("run-active");
    expect(result.messageType).toBe("warning");
    expect(result.message).toContain("Runtime evidence answer for run run-active");
    expect(result.message).toContain("Evidence missing");
    expect(result.message).not.toContain("score");
  });

  it("redacts evaluator gap summaries in blocker output", () => {
    const result = buildRuntimeEvidenceAnswer({
      text: "What is blocked?",
      topics: ["blocker"],
      snapshot: null,
      health: null,
      run: run(),
      summary: summary({
        evaluator_summary: {
          ...summary().evaluator_summary,
          gap: {
            kind: "candidate_mismatch",
            summary: "Local candidate token=super-secret-value differs from external best.",
            local_candidate_id: "local",
            external_candidate_id: "external",
          },
        },
      }),
      now: NOW,
    });

    expect(result.message).toContain("[REDACTED]");
    expect(result.message).not.toContain("super-secret-value");
  });
});
