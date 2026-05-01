import * as fsp from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../tests/helpers/temp-dir.js";
import { RuntimeEvidenceLedger } from "../store/evidence-ledger.js";

describe("RuntimeEvidenceLedger", () => {
  let runtimeRoot: string;

  beforeEach(() => {
    runtimeRoot = makeTempDir("pulseed-runtime-evidence-");
  });

  afterEach(async () => {
    await fsp.rm(runtimeRoot, { recursive: true, force: true });
  });

  it("appends entries and reads them after constructing a new ledger", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      kind: "strategy",
      scope: { goal_id: "goal-a", run_id: "run:coreloop:a", loop_index: 0 },
      strategy: "continue",
      summary: "Try the direct implementation path.",
      outcome: "continued",
    });

    const reloaded = new RuntimeEvidenceLedger(runtimeRoot);
    await reloaded.append({
      kind: "verification",
      scope: { goal_id: "goal-a", run_id: "run:coreloop:a", task_id: "task-a", loop_index: 0 },
      verification: { verdict: "pass", confidence: 0.9, summary: "unit test passed" },
      summary: "Verification pass for task-a",
      outcome: "improved",
    });

    const byGoal = await reloaded.readByGoal("goal-a");
    const byRun = await reloaded.readByRun("run:coreloop:a");

    expect(byGoal.warnings).toEqual([]);
    expect(byGoal.entries).toHaveLength(2);
    expect(byRun.entries.map((entry) => entry.kind)).toEqual(["strategy", "verification"]);
  });

  it("tolerates malformed JSONL rows and summarizes recent evidence", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      kind: "failure",
      scope: { goal_id: "goal-b", task_id: "task-b" },
      summary: "Verification failed.",
      verification: { verdict: "fail", confidence: 1, summary: "grep failed" },
      outcome: "failed",
    });
    await ledger.append({
      kind: "metric",
      scope: { goal_id: "goal-b" },
      metrics: [{ label: "accuracy", value: 0.82, direction: "maximize" }],
      summary: "Accuracy improved to 0.82.",
      outcome: "improved",
    });
    await fsp.appendFile(ledger.goalPath("goal-b"), "{not-json\n", "utf8");

    const summary = await new RuntimeEvidenceLedger(runtimeRoot).summarizeGoal("goal-b");

    expect(summary.total_entries).toBe(2);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.best_evidence?.summary).toBe("Accuracy improved to 0.82.");
    expect(summary.metric_trends[0]).toMatchObject({
      metric_key: "accuracy",
      trend: "noisy",
      latest_value: 0.82,
    });
    expect(summary.recent_failed_attempts[0]?.summary).toBe("Verification failed.");
  });

  it("stores metric provenance fields and summarizes trend history", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      kind: "metric",
      scope: { goal_id: "goal-c" },
      metrics: [{
        label: "accuracy",
        value: 0.72,
        direction: "maximize",
        confidence: 0.8,
        observed_at: "2026-04-30T00:00:00.000Z",
        source: "local-metrics.json",
      }],
      artifacts: [{ label: "metrics", state_relative_path: "experiments/a/metrics.json", kind: "metrics" }],
      summary: "Initial local metric.",
      outcome: "continued",
    });
    await ledger.append({
      kind: "metric",
      scope: { goal_id: "goal-c" },
      metrics: [{
        label: "accuracy",
        value: 0.91,
        direction: "maximize",
        confidence: 0.9,
        observed_at: "2026-04-30T00:10:00.000Z",
        source: "local-metrics.json",
      }],
      artifacts: [{ label: "metrics", state_relative_path: "experiments/b/metrics.json", kind: "metrics" }],
      summary: "New best local metric.",
      outcome: "improved",
    });

    const summary = await ledger.summarizeGoal("goal-c");

    expect(summary.metric_trends).toHaveLength(1);
    expect(summary.metric_trends[0]).toMatchObject({
      metric_key: "accuracy",
      trend: "breakthrough",
      best_value: 0.91,
      latest_value: 0.91,
    });
    expect(summary.metric_trends[0]?.source_refs[0]?.artifacts?.[0]?.state_relative_path).toBe("experiments/a/metrics.json");
    expect(summary.metric_trends[0]?.source_refs[0]?.metric_source).toBe("local-metrics.json");
  });

  it("selects the best maximize metric evidence ahead of an older improved entry", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "old-improved",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-maximize" },
      metrics: [{ label: "accuracy", value: 0.72, direction: "maximize", confidence: 0.9 }],
      artifacts: [{ label: "old-metrics", state_relative_path: "runs/old/metrics.json", kind: "metrics" }],
      summary: "Old shallow improvement.",
      outcome: "improved",
    });
    await ledger.append({
      id: "new-best",
      occurred_at: "2026-04-30T00:10:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-maximize" },
      metrics: [{ label: "accuracy", value: 0.91, direction: "maximize", confidence: 0.8 }],
      artifacts: [{ label: "new-metrics", state_relative_path: "runs/new/metrics.json", kind: "metrics" }],
      summary: "New stronger metric evidence.",
      outcome: "continued",
    });

    const summary = await ledger.summarizeGoal("goal-maximize");

    expect(summary.best_evidence?.id).toBe("new-best");
    expect(summary.best_evidence?.artifacts[0]?.state_relative_path).toBe("runs/new/metrics.json");
  });

  it("selects the best minimize metric evidence", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "higher-loss",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-minimize" },
      metrics: [{ label: "validation_loss", value: 0.42, direction: "minimize" }],
      summary: "Loss improved from baseline.",
      outcome: "improved",
    });
    await ledger.append({
      id: "lower-loss",
      occurred_at: "2026-04-30T00:05:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-minimize" },
      metrics: [{ label: "validation_loss", value: 0.31, direction: "minimize" }],
      summary: "Loss reached the best value.",
      outcome: "continued",
    });

    const summary = await ledger.summarizeGoal("goal-minimize");

    expect(summary.best_evidence?.id).toBe("lower-loss");
  });

  it("does not compare metric entries that reuse a label with the opposite direction", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "old-minimize-score",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-direction-key" },
      metrics: [{ label: "score", value: 0.1, direction: "minimize" }],
      artifacts: [{ label: "old-score", state_relative_path: "runs/old-score/metrics.json", kind: "metrics" }],
      summary: "Old score used a minimize contract.",
      outcome: "improved",
    });
    await ledger.append({
      id: "new-maximize-score",
      occurred_at: "2026-04-30T00:10:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-direction-key" },
      metrics: [{ label: "score", value: 0.9, direction: "maximize" }],
      artifacts: [{ label: "new-score", state_relative_path: "runs/new-score/metrics.json", kind: "metrics" }],
      summary: "New score uses the active maximize contract.",
      outcome: "continued",
    });

    const summary = await ledger.summarizeGoal("goal-direction-key");

    expect(summary.best_evidence?.id).toBe("new-maximize-score");
  });

  it("treats the first directed numeric metric as primary when secondary metrics differ", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "best-primary",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-primary" },
      metrics: [
        { label: "accuracy", value: 0.9, direction: "maximize" },
        { label: "latency_ms", value: 320, direction: "minimize" },
      ],
      summary: "Best primary accuracy with weaker latency.",
      outcome: "improved",
    });
    await ledger.append({
      id: "best-secondary",
      occurred_at: "2026-04-30T00:10:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-primary" },
      metrics: [
        { label: "accuracy", value: 0.86, direction: "maximize" },
        { label: "latency_ms", value: 120, direction: "minimize" },
      ],
      summary: "Secondary latency improved while primary regressed.",
      outcome: "continued",
    });

    const summary = await ledger.summarizeGoal("goal-primary");

    expect(summary.best_evidence?.id).toBe("best-primary");
  });

  it("preserves compatible fallback selection for non-metric evidence", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "passed-verification",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "verification",
      scope: { goal_id: "goal-fallback" },
      verification: { verdict: "pass", confidence: 0.9, summary: "smoke passed" },
      summary: "Verification passed.",
      outcome: "continued",
    });
    await ledger.append({
      id: "latest-artifact",
      occurred_at: "2026-04-30T00:10:00.000Z",
      kind: "artifact",
      scope: { goal_id: "goal-fallback" },
      artifacts: [{ label: "report", state_relative_path: "runs/latest/report.md", kind: "report" }],
      summary: "Latest artifact without metric.",
      outcome: "continued",
    });

    const summary = await ledger.summarizeGoal("goal-fallback");

    expect(summary.best_evidence?.id).toBe("passed-verification");
  });

  it("stores local and external evaluator observations with candidate provenance", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      kind: "evaluator",
      scope: { goal_id: "goal-evaluator", run_id: "run:coreloop:evaluator" },
      artifacts: [{ label: "submission-a", state_relative_path: "runs/a/submission.csv", kind: "other" }],
      evaluators: [{
        evaluator_id: "leaderboard",
        signal: "local",
        source: "local-validation",
        candidate_id: "candidate-a",
        candidate_label: "Candidate A",
        artifact_labels: ["submission-a"],
        status: "ready",
        score: 0.88,
        direction: "maximize",
        publish_action: {
          id: "submit-candidate-a",
          label: "Submit Candidate A",
          payload_ref: "runs/a/submission.csv",
          approval_required: true,
        },
      }],
      summary: "Candidate A is ready for external evaluation.",
    });
    await ledger.append({
      kind: "evaluator",
      scope: { goal_id: "goal-evaluator", run_id: "run:coreloop:evaluator" },
      artifacts: [{ label: "submission-a", state_relative_path: "runs/a/submission.csv", kind: "other" }],
      evaluators: [{
        evaluator_id: "leaderboard",
        signal: "external",
        source: "public-leaderboard",
        candidate_id: "candidate-a",
        artifact_labels: ["submission-a"],
        status: "passed",
        score: 0.89,
        expected_score: 0.88,
        direction: "maximize",
        provenance: {
          kind: "external_url",
          url: "https://example.com/submissions/456",
          external_id: "submission-456",
        },
      }],
      summary: "External leaderboard confirmed Candidate A.",
    });

    const summary = await ledger.summarizeGoal("goal-evaluator");

    expect(summary.evaluator_summary.local_best).toMatchObject({
      signal: "local",
      candidate_id: "candidate-a",
      artifacts: [{ state_relative_path: "runs/a/submission.csv" }],
    });
    expect(summary.evaluator_summary.external_best).toMatchObject({
      signal: "external",
      candidate_id: "candidate-a",
      provenance: { external_id: "submission-456" },
    });
    expect(summary.evaluator_summary.observations.find((observation) => observation.publish_action)?.publish_action).toMatchObject({
      id: "submit-candidate-a",
      approval_required: true,
    });
    expect(summary.evaluator_summary.approval_required_actions).toEqual([]);
    expect(summary.evaluator_summary.gap).toMatchObject({
      kind: "external_success",
      candidate_id: "candidate-a",
    });
  });

  it("stores public research evidence with source URLs and applicability notes", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      kind: "research",
      scope: { goal_id: "goal-research", phase: "public_research" },
      research: [{
        trigger: "knowledge_gap",
        query: "Find official migration guidance",
        summary: "Official docs recommend a staged migration.",
        sources: [{
          url: "https://example.com/docs/migration",
          title: "Migration guide",
          source_type: "official_docs",
          provenance: "paraphrased",
        }],
        findings: [{
          finding: "Staged migration reduces blast radius.",
          source_urls: ["https://example.com/docs/migration"],
          applicability: "Applies to API client migration work.",
          risks_constraints: ["Version skew still needs local tests."],
          proposed_experiment: "Run both client versions against the focused test lane.",
          expected_metric_impact: "Lower failure risk before rollout.",
          fact_vs_adaptation: {
            facts: ["The source recommends staged migration."],
            adaptation: "Apply it as a local compatibility test before changing runtime defaults.",
          },
        }],
        external_actions: [{
          label: "Publish migration report",
          reason: "External publication requires operator approval.",
          approval_required: true,
        }],
        untrusted_content_policy: "webpage_instructions_are_untrusted",
        confidence: 0.82,
      }],
      raw_refs: [{ kind: "research_source", url: "https://example.com/docs/migration" }],
      summary: "Public research memo saved.",
    });

    const summary = await ledger.summarizeGoal("goal-research");

    expect(summary.research_memos).toHaveLength(1);
    expect(summary.research_memos[0]).toMatchObject({
      trigger: "knowledge_gap",
      phase: "public_research",
      sources: [{ url: "https://example.com/docs/migration" }],
      findings: [{ applicability: "Applies to API client migration work." }],
      external_actions: [{ approval_required: true }],
      untrusted_content_policy: "webpage_instructions_are_untrusted",
    });
  });

  it("stores Dream review checkpoints with advisory-only memory provenance", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      kind: "dream_checkpoint",
      scope: { goal_id: "goal-dream", run_id: "run:coreloop:dream", loop_index: 3, phase: "dream_review_checkpoint" },
      dream_checkpoints: [{
        trigger: "plateau",
        summary: "Dream review found a bounded variant worth trying.",
        current_goal: "Improve benchmark score",
        active_dimensions: ["accuracy"],
        best_evidence_so_far: "Accuracy stalled at 0.82.",
        recent_strategy_families: ["continue"],
        exhausted: ["repeat baseline"],
        promising: ["bounded ablation"],
        relevant_memories: [{
          source_type: "soil",
          ref: "soil://goal-dream/checkpoint",
          summary: "Earlier run improved after an ablation.",
          authority: "advisory_only",
        }],
        next_strategy_candidates: [{
          title: "Bounded ablation",
          rationale: "Changes one factor before broadening exploration.",
          target_dimensions: ["accuracy"],
          expected_evidence_gain: "Separates model saturation from search saturation.",
        }],
        guidance: "Generate the next task around one bounded ablation.",
        uncertainty: ["Need one more local metric sample."],
        context_authority: "advisory_only",
        confidence: 0.86,
      }],
      raw_refs: [{ kind: "dream_soil_memory", id: "soil://goal-dream/checkpoint" }],
      summary: "Dream review checkpoint saved.",
    });

    const summary = await ledger.summarizeGoal("goal-dream");

    expect(summary.dream_checkpoints).toHaveLength(1);
    expect(summary.dream_checkpoints[0]).toMatchObject({
      trigger: "plateau",
      loop_index: 3,
      phase: "dream_review_checkpoint",
      context_authority: "advisory_only",
      relevant_memories: [{
        source_type: "soil",
        ref: "soil://goal-dream/checkpoint",
        authority: "advisory_only",
      }],
      next_strategy_candidates: [{ title: "Bounded ablation" }],
    });
  });

  it("stores divergent exploration hypotheses as speculative evidence", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      kind: "strategy",
      scope: { goal_id: "goal-divergent", run_id: "run:coreloop:divergent", loop_index: 4, phase: "divergent_stall_recovery" },
      divergent_exploration: [{
        strategy_id: "strategy-divergent",
        hypothesis: "Run a smoke-scale distribution audit before more threshold tuning.",
        strategy_family: "data-audit",
        role: "divergent_exploration",
        novelty_score: 0.86,
        similarity_to_recent_failures: 0.1,
        expected_cost: "low",
        relationship_to_lineage: "different_assumption",
        prior_evidence: "Metric trend stalled after a breakthrough.",
        smoke_status: "not_run",
        smoke_reason: "Promote only if the audit finds actionable distribution evidence.",
        evidence_authority: "speculative_hypothesis",
      }],
      summary: "Divergent recovery candidate saved.",
      outcome: "continued",
    });

    const summary = await ledger.summarizeGoal("goal-divergent");

    expect(summary.divergent_exploration).toHaveLength(1);
    expect(summary.divergent_exploration[0]).toMatchObject({
      strategy_family: "data-audit",
      role: "divergent_exploration",
      expected_cost: "low",
      relationship_to_lineage: "different_assumption",
      smoke_status: "not_run",
      evidence_authority: "speculative_hypothesis",
    });
  });
});
