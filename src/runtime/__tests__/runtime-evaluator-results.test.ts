import { describe, expect, it } from "vitest";
import {
  RuntimeEvidenceEntrySchema,
  RuntimeEvidenceEvaluatorObservationSchema,
  type RuntimeEvidenceEntry,
} from "../store/evidence-ledger.js";
import { summarizeEvidenceEvaluatorResults } from "../store/evaluator-results.js";

describe("runtime evaluator result summaries", () => {
  it("keeps local-only progress distinct from external confirmation", () => {
    const summary = summarizeEvidenceEvaluatorResults([
      evidenceEntry({
        id: "entry-local-a",
        occurred_at: "2026-04-30T00:00:00.000Z",
        artifacts: [{ label: "candidate-a", state_relative_path: "runs/a/submission.csv", kind: "other" }],
        evaluators: [{
          evaluator_id: "leaderboard",
          signal: "local",
          source: "local-validation",
          candidate_id: "candidate-a",
          candidate_label: "Candidate A",
          artifact_labels: ["candidate-a"],
          status: "passed",
          score: 0.91,
          direction: "maximize",
        }],
      }),
    ]);

    expect(summary.local_best).toMatchObject({
      signal: "local",
      candidate_id: "candidate-a",
      score: 0.91,
      artifacts: [{ state_relative_path: "runs/a/submission.csv" }],
    });
    expect(summary.external_best).toBeNull();
    expect(summary.gap).toMatchObject({ kind: "local_only", candidate_id: "candidate-a" });
  });

  it("records approval-required publish actions without treating them as submitted", () => {
    const summary = summarizeEvidenceEvaluatorResults([
      evidenceEntry({
        id: "entry-ready-a",
        occurred_at: "2026-04-30T00:05:00.000Z",
        evaluators: [{
          evaluator_id: "public-leaderboard",
          signal: "local",
          source: "local-validation",
          candidate_id: "candidate-a",
          status: "ready",
          score: 0.92,
          direction: "maximize",
          publish_action: {
            id: "submit-candidate-a",
            label: "Submit Candidate A",
            tool_name: "kaggle_submit",
            payload_ref: "runs/a/submission.csv",
            approval_required: true,
          },
        }],
      }),
    ]);

    expect(summary.approval_required_actions).toHaveLength(1);
    expect(summary.approval_required_actions[0]).toMatchObject({
      id: "submit-candidate-a",
      approval_required: true,
      status: "approval_required",
      candidate_id: "candidate-a",
    });
    expect(summary.gap?.kind).toBe("pending_external");
  });

  it("clears stale approval requests after the same publish action advances", () => {
    const summary = summarizeEvidenceEvaluatorResults([
      evidenceEntry({
        id: "entry-ready-a",
        occurred_at: "2026-04-30T00:05:00.000Z",
        evaluators: [{
          evaluator_id: "public-leaderboard",
          signal: "local",
          source: "local-validation",
          candidate_id: "candidate-a",
          status: "ready",
          score: 0.92,
          direction: "maximize",
          publish_action: {
            id: "submit-candidate-a",
            label: "Submit Candidate A",
            payload_ref: "runs/a/submission.csv",
            approval_required: true,
          },
        }],
      }),
      evidenceEntry({
        id: "entry-submitted-a",
        occurred_at: "2026-04-30T00:10:00.000Z",
        evaluators: [{
          evaluator_id: "public-leaderboard",
          signal: "local",
          source: "submission-preflight",
          candidate_id: "candidate-a",
          status: "submitted",
          score: 0.92,
          direction: "maximize",
          publish_action: {
            id: "submit-candidate-a",
            label: "Submit Candidate A",
            payload_ref: "runs/a/submission.csv",
            approval_required: true,
            status: "submitted",
          },
        }],
      }),
    ]);

    expect(summary.approval_required_actions).toEqual([]);
  });

  it("rejects external publish actions that are not approval gated", () => {
    const parsed = RuntimeEvidenceEvaluatorObservationSchema.safeParse({
      evaluator_id: "public-leaderboard",
      signal: "local",
      source: "local-validation",
      candidate_id: "candidate-a",
      publish_action: {
        id: "unsafe-submit",
        label: "Unsafe submit",
        approval_required: false,
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("links external success to the same candidate artifact and preserves provenance", () => {
    const summary = summarizeEvidenceEvaluatorResults([
      evidenceEntry({
        id: "entry-local-a",
        occurred_at: "2026-04-30T00:00:00.000Z",
        artifacts: [{ label: "candidate-a", state_relative_path: "runs/a/submission.csv", kind: "other" }],
        evaluators: [{
          evaluator_id: "leaderboard",
          signal: "local",
          source: "local-validation",
          candidate_id: "candidate-a",
          artifact_labels: ["candidate-a"],
          status: "passed",
          score: 0.91,
          direction: "maximize",
        }],
      }),
      evidenceEntry({
        id: "entry-external-a",
        occurred_at: "2026-04-30T00:20:00.000Z",
        artifacts: [{ label: "candidate-a", state_relative_path: "runs/a/submission.csv", kind: "other" }],
        evaluators: [{
          evaluator_id: "leaderboard",
          signal: "external",
          source: "public-leaderboard",
          candidate_id: "candidate-a",
          artifact_labels: ["candidate-a"],
          status: "passed",
          score: 0.913,
          expected_score: 0.91,
          direction: "maximize",
          provenance: {
            kind: "external_url",
            url: "https://example.com/leaderboard/submissions/123",
            external_id: "submission-123",
            retrieved_at: "2026-04-30T00:21:00.000Z",
          },
        }],
      }),
    ]);

    expect(summary.external_best).toMatchObject({
      signal: "external",
      candidate_id: "candidate-a",
      score: 0.913,
      provenance: { external_id: "submission-123" },
      artifacts: [{ state_relative_path: "runs/a/submission.csv" }],
    });
    expect(summary.gap).toMatchObject({
      kind: "external_success",
      candidate_id: "candidate-a",
    });
    expect(summary.gap?.score_delta).toBeCloseTo(0.003);
  });

  it("summarizes evaluator budget and calibration without allowing direct optimization", () => {
    const summary = summarizeEvidenceEvaluatorResults([
      evidenceEntry({
        id: "entry-external-calibration",
        occurred_at: "2026-04-30T00:20:00.000Z",
        evaluators: [{
          evaluator_id: "leaderboard",
          signal: "external",
          source: "public-leaderboard",
          candidate_id: "candidate-b",
          status: "passed",
          score: 0.9692,
          score_label: "balanced_accuracy",
          expected_score: 0.9704,
          direction: "maximize",
          budget: {
            policy_id: "daily-public-lb",
            max_attempts: 5,
            used_attempts: 3,
            remaining_attempts: 2,
            approval_required: true,
            phase: "consolidation",
            portfolio_policy: {
              diversified_portfolio_required: true,
              reserve_for_finalization: true,
              min_strategy_families: 2,
            },
          },
          candidate_snapshot: {
            evidence_entry_id: "candidate-snapshot-b",
            primary_metric_label: "balanced_accuracy",
            local_metrics: [
              { label: "loss", value: 0.24, direction: "minimize" },
              { label: "balanced_accuracy", value: 0.9704, direction: "maximize" },
            ],
            robust_selection: {
              raw_rank: 3,
              robust_score: 0.84,
              portfolio_role: "diverse",
            },
          },
          calibration: {
            mode: "calibration_only",
            use_for_selection: true,
            direct_optimization_allowed: false,
            minimum_observations: 2,
            conclusion: "Public leaderboard shows local OOF is slightly optimistic.",
          },
          provenance: {
            kind: "external_url",
            external_id: "submission-789",
          },
        }],
      }),
    ]);

    expect(summary.budgets).toContainEqual(expect.objectContaining({
      evaluator_id: "leaderboard",
      remaining_attempts: 2,
      approval_required: true,
      diversified_portfolio_required: true,
      reserve_for_finalization: true,
      min_strategy_families: 2,
    }));
    expect(summary.calibration).toContainEqual(expect.objectContaining({
      candidate_id: "candidate-b",
      local_evidence_entry_id: "candidate-snapshot-b",
      local_score: 0.9704,
      external_score: 0.9692,
      direct_optimization_allowed: false,
      use_for_selection: true,
      selection_adjustment: expect.any(Number),
      provenance: expect.objectContaining({ external_id: "submission-789" }),
    }));
    expect(summary.calibration[0]?.selection_adjustment).toBeLessThan(0);
  });

  it("does not compute calibration gaps from unlabeled local metrics", () => {
    const summary = summarizeEvidenceEvaluatorResults([
      evidenceEntry({
        id: "entry-unlabeled-calibration",
        occurred_at: "2026-04-30T00:20:00.000Z",
        evaluators: [{
          evaluator_id: "leaderboard",
          signal: "external",
          source: "public-leaderboard",
          candidate_id: "candidate-unlabeled",
          status: "passed",
          score: 0.9692,
          expected_score: 0.9704,
          direction: "maximize",
          candidate_snapshot: {
            local_metrics: [
              { label: "loss", value: 0.24, direction: "minimize" },
              { label: "balanced_accuracy", value: 0.9704, direction: "maximize" },
            ],
          },
          calibration: {
            mode: "calibration_only",
            use_for_selection: true,
            direct_optimization_allowed: false,
            minimum_observations: 1,
          },
        }],
      }),
    ]);

    expect(summary.calibration[0]).toMatchObject({
      candidate_id: "candidate-unlabeled",
      external_score: 0.9692,
      selection_adjustment: 0,
    });
    expect(summary.calibration[0]?.local_score).toBeUndefined();
    expect(summary.calibration[0]?.score_delta).toBeUndefined();
  });

  it("classifies external regression against local expectations", () => {
    const summary = summarizeEvidenceEvaluatorResults([
      evidenceEntry({
        id: "entry-local-a",
        occurred_at: "2026-04-30T00:00:00.000Z",
        evaluators: [{
          evaluator_id: "leaderboard",
          signal: "local",
          source: "local-validation",
          candidate_id: "candidate-a",
          status: "passed",
          score: 0.91,
          direction: "maximize",
        }],
      }),
      evidenceEntry({
        id: "entry-external-a",
        occurred_at: "2026-04-30T00:20:00.000Z",
        evaluators: [{
          evaluator_id: "leaderboard",
          signal: "external",
          source: "public-leaderboard",
          candidate_id: "candidate-a",
          status: "regressed",
          score: 0.72,
          expected_score: 0.91,
          direction: "maximize",
          provenance: {
            kind: "benchmark",
            run_id: "external-run-1",
          },
        }],
      }),
    ]);

    expect(summary.external_best).toBeNull();
    expect(summary.gap).toMatchObject({
      kind: "external_regression",
      candidate_id: "candidate-a",
      direction: "maximize",
    });
    expect(summary.gap?.score_delta).toBeCloseTo(-0.19);
  });
});

function evidenceEntry(
  overrides: Partial<RuntimeEvidenceEntry>
): RuntimeEvidenceEntry {
  return RuntimeEvidenceEntrySchema.parse({
    schema_version: "runtime-evidence-entry-v1",
    id: "entry",
    occurred_at: "2026-04-30T00:00:00.000Z",
    kind: "evaluator",
    scope: { goal_id: "goal-evaluator" },
    ...overrides,
  });
}
