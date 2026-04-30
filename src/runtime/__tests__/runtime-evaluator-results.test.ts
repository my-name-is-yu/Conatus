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
