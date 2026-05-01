import * as fsp from "node:fs/promises";
import * as path from "node:path";
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

  it("rebuilds and uses a sidecar summary index while keeping JSONL canonical", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "indexed-metric",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-index" },
      metrics: [{ label: "accuracy", value: 0.82, direction: "maximize" }],
      summary: "Indexed accuracy.",
      outcome: "improved",
    });
    await fsp.appendFile(ledger.goalPath("goal-index"), "{not-json\n", "utf8");

    const rebuilt = await ledger.rebuildSummaryIndexForGoal("goal-index");
    const indexPath = `${ledger.goalPath("goal-index")}.summary.json`;
    const indexedText = await fsp.readFile(indexPath, "utf8");
    const indexed = JSON.parse(indexedText) as { schema_version: string; summary: { warnings: unknown[] } };
    const summarized = await new RuntimeEvidenceLedger(runtimeRoot).summarizeGoal("goal-index");

    expect(rebuilt.warnings).toHaveLength(1);
    expect(indexed.schema_version).toBe("runtime-evidence-summary-index-v1");
    expect(indexed.summary.warnings).toHaveLength(1);
    expect(summarized.best_evidence?.id).toBe("indexed-metric");
    expect(summarized.warnings).toHaveLength(1);
    expect(await fsp.readFile(ledger.goalPath("goal-index"), "utf8")).toContain("{not-json");
  });

  it("maintains summary indexes on append for new ledgers", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "first-indexed-entry",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "artifact",
      scope: { run_id: "run:indexed" },
      artifacts: [{ label: "report", state_relative_path: "runs/indexed/report.md", kind: "report" }],
      summary: "First indexed artifact.",
      outcome: "continued",
    });

    const indexPath = `${ledger.runPath("run:indexed")}.summary.json`;
    const indexed = JSON.parse(await fsp.readFile(indexPath, "utf8")) as {
      summary: { total_entries: number; best_evidence: { id: string } | null };
    };
    const summary = await new RuntimeEvidenceLedger(runtimeRoot).summarizeRun("run:indexed");

    expect(indexed.summary.total_entries).toBe(1);
    expect(summary.best_evidence?.id).toBe("first-indexed-entry");
  });

  it("updates existing summary indexes after append", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "indexed-before",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "artifact",
      scope: { run_id: "run:index-update" },
      artifacts: [{ label: "old", state_relative_path: "runs/index-update/old.md", kind: "report" }],
      summary: "Old indexed artifact.",
      outcome: "continued",
    });
    await ledger.rebuildSummaryIndexForRun("run:index-update");
    await ledger.append({
      id: "indexed-after",
      occurred_at: "2026-04-30T00:10:00.000Z",
      kind: "verification",
      scope: { run_id: "run:index-update" },
      verification: { verdict: "pass", summary: "verified" },
      summary: "New indexed verification.",
      outcome: "improved",
    });

    const summary = await new RuntimeEvidenceLedger(runtimeRoot).summarizeRun("run:index-update");

    expect(summary.total_entries).toBe(2);
    expect(summary.best_evidence?.id).toBe("indexed-after");
  });

  it("rebuilds stale summary indexes that predate candidate summary fields", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "candidate-index-source",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "metric",
      scope: { run_id: "run:candidate-index" },
      candidates: [{
        candidate_id: "candidate-index-a",
        lineage: {
          strategy_family: "catboost",
          feature_lineage: [],
          model_lineage: ["catboost"],
          config_lineage: [],
          seed_lineage: [],
          fold_lineage: [],
          postprocess_lineage: [],
        },
        metrics: [{ label: "balanced_accuracy", value: 0.9, direction: "maximize" }],
        artifacts: [],
        similarity: [],
        disposition: "retained",
      }],
      summary: "Candidate index source.",
      outcome: "improved",
    });
    await ledger.rebuildSummaryIndexForRun("run:candidate-index");
    const indexPath = `${ledger.runPath("run:candidate-index")}.summary.json`;
    const staleIndex = JSON.parse(await fsp.readFile(indexPath, "utf8")) as {
      summary: Record<string, unknown>;
    };
    delete staleIndex.summary.candidate_lineages;
    delete staleIndex.summary.recommended_candidate_portfolio;
    delete staleIndex.summary.candidate_selection_summary;
    await fsp.writeFile(indexPath, `${JSON.stringify(staleIndex)}\n`, "utf8");

    const summary = await new RuntimeEvidenceLedger(runtimeRoot).summarizeRun("run:candidate-index");

    expect(summary.candidate_lineages).toHaveLength(1);
    expect(summary.recommended_candidate_portfolio[0]?.candidate_id).toBe("candidate-index-a");
    expect(summary.candidate_selection_summary.raw_best?.candidate_id).toBe("candidate-index-a");
  });

  it("preserves full canonical history when append maintains an existing index", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    for (let index = 0; index < 12; index += 1) {
      await ledger.append({
        id: `history-${index}`,
        occurred_at: new Date(Date.UTC(2026, 3, 30, 0, 0, index)).toISOString(),
        kind: "metric",
        scope: { run_id: "run:index-history", loop_index: index },
        metrics: [{ label: "accuracy", value: index, direction: "maximize" }],
        summary: `History metric ${index}`,
        outcome: index === 11 ? "improved" : "continued",
      });
    }

    const summary = await new RuntimeEvidenceLedger(runtimeRoot).summarizeRun("run:index-history");

    expect(summary.total_entries).toBe(12);
    expect(summary.recent_entries).toHaveLength(10);
    expect(summary.best_evidence?.id).toBe("history-11");
    expect(summary.metric_trends[0]?.latest_value).toBe(11);
  });

  it("does not let stale indexes mask canonical JSONL warnings on append", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "warning-before",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "metric",
      scope: { run_id: "run:index-warning" },
      metrics: [{ label: "accuracy", value: 1, direction: "maximize" }],
      summary: "Before corrupt line.",
      outcome: "continued",
    });
    await ledger.rebuildSummaryIndexForRun("run:index-warning");
    await fsp.appendFile(ledger.runPath("run:index-warning"), "{bad-json\n", "utf8");
    await ledger.append({
      id: "warning-after",
      occurred_at: "2026-04-30T00:10:00.000Z",
      kind: "metric",
      scope: { run_id: "run:index-warning" },
      metrics: [{ label: "accuracy", value: 2, direction: "maximize" }],
      summary: "After corrupt line.",
      outcome: "improved",
    });

    const summary = await new RuntimeEvidenceLedger(runtimeRoot).summarizeRun("run:index-warning");

    expect(summary.total_entries).toBe(2);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.best_evidence?.id).toBe("warning-after");
  });

  it("uses summary indexes for 100/500/1000 entry summaries without reading canonical JSONL", async () => {
    const sizes = [100, 500, 1000];
    for (const size of sizes) {
      const runId = `run:scale-${size}`;
      const ledger = new RuntimeEvidenceLedger(runtimeRoot);
      const entries = Array.from({ length: size }, (_, index) => ({
        schema_version: "runtime-evidence-entry-v1",
        id: `entry-${size}-${index}`,
        occurred_at: new Date(Date.UTC(2026, 3, 30, 0, 0, index)).toISOString(),
        kind: "metric",
        scope: { run_id: runId, loop_index: index },
        metrics: [{ label: "accuracy", value: index / size, direction: "maximize" }],
        evaluators: [],
        research: [],
        dream_checkpoints: [],
        divergent_exploration: [],
        artifacts: [],
        raw_refs: [],
        summary: `Metric ${index}`,
        outcome: index === size - 1 ? "improved" : "continued",
      }));
      await fsp.mkdir(path.dirname(ledger.runPath(runId)), { recursive: true });
      await fsp.writeFile(
        ledger.runPath(runId),
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
        "utf8"
      );
      await ledger.rebuildSummaryIndexForRun(runId);
      const indexPath = `${ledger.runPath(runId)}.summary.json`;
      const index = JSON.parse(await fsp.readFile(indexPath, "utf8")) as {
        summary: { generated_at: string };
      };
      index.summary.generated_at = `indexed-summary-${size}`;
      await fsp.writeFile(indexPath, `${JSON.stringify(index)}\n`, "utf8");

      const summary = await new RuntimeEvidenceLedger(runtimeRoot).summarizeRun(runId);

      expect(summary.total_entries).toBe(size);
      expect(summary.best_evidence?.id).toBe(`entry-${size}-${size - 1}`);
      expect(summary.generated_at).toBe(`indexed-summary-${size}`);
    }
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

  it("aggregates repeated failed approaches into failed lineages without mixing divergent approaches", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    for (let index = 0; index < 3; index += 1) {
      await ledger.append({
        id: `failed-threshold-${index + 1}`,
        occurred_at: `2026-04-30T00:0${index}:00.000Z`,
        kind: "failure",
        scope: { goal_id: "goal-lineage", task_id: `task-threshold-${index + 1}` },
        strategy: "threshold_sweep",
        hypothesis: "Repeat threshold sweep improves balanced accuracy",
        task: {
          id: `task-threshold-${index + 1}`,
          action: "threshold_sweep",
          primary_dimension: "balanced_accuracy",
        },
        verification: {
          verdict: "fail",
          summary: [
            "Balanced accuracy stayed inside noise.",
            "No significant balanced accuracy gain.",
            "Metric stayed flat after the sweep.",
          ][index],
        },
        summary: "Threshold sweep failed.",
        outcome: "failed",
      });
    }
    await ledger.append({
      id: "failed-ablation",
      occurred_at: "2026-04-30T00:10:00.000Z",
      kind: "failure",
      scope: { goal_id: "goal-lineage", task_id: "task-ablation" },
      strategy: "feature_ablation",
      hypothesis: "Ablate leakage-prone feature group",
      task: {
        id: "task-ablation",
        action: "feature_ablation",
        primary_dimension: "balanced_accuracy",
      },
      verification: { verdict: "fail", summary: "Ablation reduced balanced accuracy." },
      summary: "Ablation failed differently.",
      outcome: "failed",
    });

    const summary = await ledger.summarizeGoal("goal-lineage");

    expect(summary.failed_lineages).toHaveLength(2);
    expect(summary.failed_lineages[0]).toMatchObject({
      count: 3,
      strategy_family: "threshold_sweep",
      primary_dimension: "balanced_accuracy",
      representative_entry_id: "failed-threshold-3",
    });
    expect(summary.failed_lineages[0]?.evidence_entry_ids).toEqual([
      "failed-threshold-1",
      "failed-threshold-2",
      "failed-threshold-3",
    ]);
    expect(summary.failed_lineages[1]).toMatchObject({
      count: 1,
      strategy_family: "feature_ablation",
    });
  });

  it("retains a lower-score diverse candidate in the recommended lineage portfolio", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "candidate-snapshot",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-candidate-lineage", run_id: "run:candidate-lineage" },
      candidates: [
        {
          candidate_id: "catboost-seed-42",
          label: "CatBoost seed 42",
          lineage: {
            source_strategy_id: "strategy-catboost",
            strategy_family: "catboost",
            feature_lineage: ["base-features"],
            model_lineage: ["catboost"],
            config_lineage: ["depth-6", "lr-0.06"],
            seed_lineage: ["seed-42"],
            fold_lineage: ["5-fold-oof"],
            postprocess_lineage: ["none"],
          },
          metrics: [{ label: "balanced_accuracy", value: 0.984, direction: "maximize", confidence: 0.88 }],
          artifacts: [{ label: "metrics-a", state_relative_path: "runs/catboost-seed-42/metrics.json", kind: "metrics" }],
          similarity: [{ candidate_id: "catboost-seed-99", similarity: 0.96, signal: "declared" }],
          disposition: "promoted",
          disposition_reason: "Best local metric inside the CatBoost family.",
        },
        {
          candidate_id: "catboost-seed-99",
          label: "CatBoost seed 99",
          lineage: {
            parent_candidate_id: "catboost-seed-42",
            source_strategy_id: "strategy-catboost",
            strategy_family: "catboost",
            feature_lineage: ["base-features"],
            model_lineage: ["catboost"],
            config_lineage: ["depth-6", "lr-0.06"],
            seed_lineage: ["seed-99"],
            fold_lineage: ["5-fold-oof"],
            postprocess_lineage: ["none"],
          },
          metrics: [{ label: "balanced_accuracy", value: 0.982, direction: "maximize", confidence: 0.87 }],
          artifacts: [{ label: "metrics-b", state_relative_path: "runs/catboost-seed-99/metrics.json", kind: "metrics" }],
          similarity: [{ candidate_id: "catboost-seed-42", similarity: 0.96, signal: "declared" }],
          disposition: "retained",
          disposition_reason: "High-score seed variant, but near-duplicate of the family representative.",
        },
        {
          candidate_id: "linear-stack",
          label: "Linear stack",
          lineage: {
            source_strategy_id: "strategy-linear-stack",
            strategy_family: "linear_stack",
            feature_lineage: ["rank-features"],
            model_lineage: ["ridge-stack"],
            config_lineage: ["stack-v1"],
            seed_lineage: ["seed-7"],
            fold_lineage: ["5-fold-oof"],
            postprocess_lineage: ["class-prior-calibration"],
          },
          metrics: [{ label: "balanced_accuracy", value: 0.951, direction: "maximize", confidence: 0.8 }],
          artifacts: [{ label: "metrics-c", state_relative_path: "runs/linear-stack/metrics.json", kind: "metrics" }],
          similarity: [],
          disposition: "retained",
          disposition_reason: "Lower local score, but a distinct mechanism that can complement the CatBoost lineage.",
        },
      ],
      summary: "Candidate lineage snapshot after local validation.",
      outcome: "improved",
    });

    const summary = await ledger.summarizeGoal("goal-candidate-lineage");

    expect(summary.candidate_lineages.map((lineage) => lineage.strategy_family)).toEqual([
      "catboost",
      "linear_stack",
    ]);
    expect(summary.candidate_lineages[0]).toMatchObject({
      strategy_family: "catboost",
      candidate_ids: ["catboost-seed-42", "catboost-seed-99"],
      best_candidate_id: "catboost-seed-42",
      best_metric: { label: "balanced_accuracy", value: 0.984, direction: "maximize" },
    });
    expect(summary.candidate_lineages[0]?.diversity_notes).toContain(
      "catboost-seed-42 near-duplicate of catboost-seed-99"
    );
    expect(summary.recommended_candidate_portfolio.map((slot) => slot.candidate_id)).toEqual([
      "catboost-seed-42",
      "linear-stack",
      "catboost-seed-99",
    ]);
    expect(summary.recommended_candidate_portfolio[1]).toMatchObject({
      candidate_id: "linear-stack",
      strategy_family: "linear_stack",
      role: "diverse_representative",
      retained_reason: "Lower local score, but a distinct mechanism that can complement the CatBoost lineage.",
    });
    expect(summary.recommended_candidate_portfolio[2]).toMatchObject({
      candidate_id: "catboost-seed-99",
      role: "lineage_representative",
      similarity_to_selected: {
        candidate_id: "catboost-seed-42",
        similarity: 0.96,
      },
    });
  });

  it("ranks diversified candidates by the primary metric label instead of unrelated scores", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "mixed-metric-candidate-snapshot",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-candidate-primary-metric" },
      candidates: [
        {
          candidate_id: "local-best",
          lineage: {
            strategy_family: "catboost",
            feature_lineage: ["base-features"],
            model_lineage: ["catboost"],
            config_lineage: [],
            seed_lineage: [],
            fold_lineage: [],
            postprocess_lineage: [],
          },
          metrics: [
            { label: "balanced_accuracy", value: 0.97, direction: "maximize" },
            { label: "public_lb", value: 0.94, direction: "maximize" },
          ],
          artifacts: [],
          similarity: [],
          disposition: "promoted",
        },
        {
          candidate_id: "public-only-spike",
          lineage: {
            strategy_family: "public-probe",
            feature_lineage: ["probe-features"],
            model_lineage: ["probe"],
            config_lineage: [],
            seed_lineage: [],
            fold_lineage: [],
            postprocess_lineage: [],
          },
          metrics: [
            { label: "public_lb", value: 0.999, direction: "maximize" },
            { label: "balanced_accuracy", value: 0.91, direction: "maximize" },
          ],
          artifacts: [],
          similarity: [],
          disposition: "retained",
        },
      ],
      summary: "Mixed candidate metrics snapshot.",
      outcome: "improved",
    });

    const summary = await ledger.summarizeGoal("goal-candidate-primary-metric");

    expect(summary.recommended_candidate_portfolio[0]).toMatchObject({
      candidate_id: "local-best",
      metric: {
        label: "balanced_accuracy",
        value: 0.97,
      },
    });
  });

  it("separates raw best from robust best and recommends safe aggressive diverse slots", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "robust-selection-snapshot",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-robust-selection" },
      candidates: [
        {
          candidate_id: "manual-mvs-raw-best",
          label: "Manual MVS raw best",
          lineage: {
            strategy_family: "catboost_manual_mvs",
            feature_lineage: ["focus-base"],
            model_lineage: ["catboost"],
            config_lineage: ["manual-class-weight", "mvs"],
            seed_lineage: ["seed-42"],
            fold_lineage: ["5-fold-oof"],
            postprocess_lineage: ["manual-threshold"],
          },
          metrics: [{ label: "balanced_accuracy", value: 0.97084, direction: "maximize", confidence: 0.78 }],
          artifacts: [{ label: "raw-best-metrics", state_relative_path: "runs/manual-mvs/metrics.json", kind: "metrics" }],
          similarity: [],
          robustness: {
            stability_score: 0.42,
            diversity_score: 0.25,
            risk_penalty: 0.28,
            evidence_confidence: 0.72,
            repeated_evaluations: 1,
            mean_score: 0.9688,
            max_score: 0.97084,
            score_stddev: 0.0018,
            fold_score_range: 0.012,
            seed_score_range: 0.009,
            weak_dimensions: ["High recall"],
            provenance_refs: ["runs/manual-mvs/metrics.json"],
            summary: "Highest local score but unstable and post-processing dependent.",
          },
          disposition: "promoted",
          disposition_reason: "Raw best local metric, kept as aggressive candidate.",
        },
        {
          candidate_id: "default-rs314-robust",
          label: "Default rs314 robust",
          lineage: {
            strategy_family: "catboost_default",
            feature_lineage: ["focus-base"],
            model_lineage: ["catboost"],
            config_lineage: ["default-class-weight"],
            seed_lineage: ["seed-314"],
            fold_lineage: ["5-fold-oof"],
            postprocess_lineage: ["none"],
          },
          metrics: [{ label: "balanced_accuracy", value: 0.97041, direction: "maximize", confidence: 0.9 }],
          artifacts: [{ label: "robust-metrics", state_relative_path: "runs/default-rs314/metrics.json", kind: "metrics" }],
          similarity: [{ candidate_id: "manual-mvs-raw-best", similarity: 0.62, signal: "declared" }],
          robustness: {
            stability_score: 0.94,
            diversity_score: 0.58,
            risk_penalty: 0.02,
            evidence_confidence: 0.92,
            repeated_evaluations: 4,
            mean_score: 0.97012,
            max_score: 0.97041,
            score_stddev: 0.0002,
            fold_score_range: 0.003,
            seed_score_range: 0.002,
            weak_dimensions: [],
            provenance_refs: ["runs/default-rs314/metrics.json", "runs/default-rs314/folds.json"],
            summary: "Slightly lower local score but stable across folds and seeds.",
          },
          disposition: "retained",
          disposition_reason: "Stable lower-score candidate selected as robust best.",
        },
        {
          candidate_id: "renamed-catboost-duplicate",
          label: "Renamed CatBoost duplicate",
          lineage: {
            strategy_family: "catboost_default_copy",
            feature_lineage: ["focus-base"],
            model_lineage: ["catboost"],
            config_lineage: ["default-class-weight"],
            seed_lineage: ["seed-2718"],
            fold_lineage: ["5-fold-oof"],
            postprocess_lineage: ["none"],
          },
          metrics: [{ label: "balanced_accuracy", value: 0.968, direction: "maximize", confidence: 0.85 }],
          artifacts: [{ label: "duplicate-metrics", state_relative_path: "runs/renamed-catboost/metrics.json", kind: "metrics" }],
          similarity: [{ candidate_id: "default-rs314-robust", similarity: 0.94, signal: "declared" }],
          robustness: {
            stability_score: 0.8,
            risk_penalty: 0.02,
            evidence_confidence: 0.85,
            repeated_evaluations: 2,
            mean_score: 0.9679,
            max_score: 0.968,
            score_stddev: 0.0003,
            fold_score_range: 0.003,
            seed_score_range: 0.003,
            weak_dimensions: [],
            provenance_refs: ["runs/renamed-catboost/metrics.json"],
            summary: "Family label differs, but declared similarity shows this is not a diverse lineage.",
          },
          disposition: "retained",
          disposition_reason: "Near-duplicate retained as backup, not as diverse portfolio representative.",
        },
        {
          candidate_id: "linear-stack-diverse",
          label: "Linear stack diverse",
          lineage: {
            strategy_family: "linear_stack",
            feature_lineage: ["rank-features"],
            model_lineage: ["ridge-stack"],
            config_lineage: ["stack-v1"],
            seed_lineage: ["seed-7"],
            fold_lineage: ["5-fold-oof"],
            postprocess_lineage: ["class-prior-calibration"],
          },
          metrics: [{ label: "balanced_accuracy", value: 0.963, direction: "maximize", confidence: 0.86 }],
          artifacts: [{ label: "diverse-metrics", state_relative_path: "runs/linear-stack/metrics.json", kind: "metrics" }],
          similarity: [{ candidate_id: "default-rs314-robust", similarity: 0.31, signal: "declared" }],
          robustness: {
            stability_score: 0.81,
            risk_penalty: 0.05,
            evidence_confidence: 0.84,
            repeated_evaluations: 3,
            mean_score: 0.9628,
            max_score: 0.963,
            score_stddev: 0.0004,
            fold_score_range: 0.004,
            seed_score_range: 0.003,
            weak_dimensions: [],
            provenance_refs: ["runs/linear-stack/metrics.json"],
            summary: "Different lineage retained for complementary final selection.",
          },
          disposition: "retained",
          disposition_reason: "Diverse lineage with stable evidence.",
        },
      ],
      summary: "Robust candidate selection snapshot.",
      outcome: "improved",
    });

    const selection = (await ledger.summarizeGoal("goal-robust-selection")).candidate_selection_summary;

    expect(selection.primary_metric).toEqual({ label: "balanced_accuracy", direction: "maximize" });
    expect(selection.raw_best).toMatchObject({
      candidate_id: "manual-mvs-raw-best",
      raw_rank: 1,
      raw_metric: { value: 0.97084 },
    });
    expect(selection.robust_best).toMatchObject({
      candidate_id: "default-rs314-robust",
      raw_rank: 2,
      stability_score: 0.94,
      risk_penalty: 0.02,
    });
    expect(selection.robust_best?.robust_score).toBeGreaterThan(selection.raw_best?.robust_score ?? 0);
    expect(selection.final_portfolio.safe?.candidate_id).toBe("default-rs314-robust");
    expect(selection.final_portfolio.aggressive?.candidate_id).toBe("manual-mvs-raw-best");
    expect(selection.final_portfolio.diverse?.candidate_id).toBe("linear-stack-diverse");
    expect(selection.ranked.map((candidate) => candidate.candidate_id)).toContain("manual-mvs-raw-best");
  });

  it("does not fill the diverse slot with a declared near-duplicate from another family", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    await ledger.append({
      id: "near-duplicate-only-selection",
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-no-diverse-near-duplicate" },
      candidates: [
        {
          candidate_id: "stable-best",
          lineage: {
            strategy_family: "catboost_default",
            feature_lineage: ["base"],
            model_lineage: ["catboost"],
            config_lineage: [],
            seed_lineage: ["seed-1"],
            fold_lineage: ["5-fold"],
            postprocess_lineage: [],
          },
          metrics: [{ label: "balanced_accuracy", value: 0.97, direction: "maximize", confidence: 0.9 }],
          artifacts: [],
          similarity: [{ candidate_id: "renamed-near-duplicate", similarity: 0.95, signal: "declared" }],
          robustness: {
            stability_score: 0.9,
            risk_penalty: 0.01,
            evidence_confidence: 0.9,
            weak_dimensions: [],
            provenance_refs: [],
          },
          disposition: "retained",
        },
        {
          candidate_id: "renamed-near-duplicate",
          lineage: {
            strategy_family: "catboost_renamed",
            feature_lineage: ["base"],
            model_lineage: ["catboost"],
            config_lineage: [],
            seed_lineage: ["seed-2"],
            fold_lineage: ["5-fold"],
            postprocess_lineage: [],
          },
          metrics: [{ label: "balanced_accuracy", value: 0.969, direction: "maximize", confidence: 0.88 }],
          artifacts: [],
          similarity: [],
          robustness: {
            stability_score: 0.88,
            diversity_score: 0.9,
            risk_penalty: 0.01,
            evidence_confidence: 0.88,
            weak_dimensions: [],
            provenance_refs: [],
          },
          disposition: "retained",
        },
      ],
      summary: "Near duplicate should not fill diverse slot.",
      outcome: "continued",
    });

    const selection = (await ledger.summarizeGoal("goal-no-diverse-near-duplicate")).candidate_selection_summary;

    expect(selection.final_portfolio.diverse).toBeNull();
    expect(selection.ranked.find((candidate) => candidate.candidate_id === "renamed-near-duplicate")).toMatchObject({
      diversity_score: 0.05,
    });
  });

  it("preserves near-miss non-winners during stalled candidate selection", async () => {
    const ledger = new RuntimeEvidenceLedger(runtimeRoot);
    for (const [index, value] of [0.9704, 0.97042, 0.97041].entries()) {
      await ledger.append({
        id: `stalled-balanced-accuracy-${index + 1}`,
        occurred_at: `2026-04-30T00:0${index}:00.000Z`,
        kind: "metric",
        scope: { goal_id: "goal-near-miss-stall", loop_index: index },
        metrics: [{ label: "balanced_accuracy", value, direction: "maximize", confidence: 0.9 }],
        summary: "Balanced accuracy stayed inside the plateau band.",
        outcome: "continued",
      });
    }
    await ledger.append({
      id: "near-miss-candidate-snapshot",
      occurred_at: "2026-04-30T00:10:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-near-miss-stall", loop_index: 4 },
      candidates: [
        {
          candidate_id: "raw-best-threshold",
          label: "Raw best threshold",
          lineage: {
            strategy_family: "threshold_sweep",
            feature_lineage: ["base"],
            model_lineage: ["catboost"],
            config_lineage: ["manual-threshold"],
            seed_lineage: ["seed-42"],
            fold_lineage: ["5-fold"],
            postprocess_lineage: ["threshold-0.48"],
          },
          metrics: [{ label: "balanced_accuracy", value: 0.97042, direction: "maximize", confidence: 0.78 }],
          artifacts: [],
          similarity: [],
          robustness: {
            stability_score: 0.45,
            risk_penalty: 0.2,
            evidence_confidence: 0.72,
            weak_dimensions: [],
            provenance_refs: ["runs/raw-best/metrics.json"],
          },
          disposition: "promoted",
          disposition_reason: "Highest local metric, but not the only promising path.",
        },
        {
          candidate_id: "weak-class-near-miss",
          label: "Weak class near miss",
          lineage: {
            strategy_family: "class_weight_focus",
            feature_lineage: ["base"],
            model_lineage: ["catboost"],
            config_lineage: ["class-weight-minority"],
            seed_lineage: ["seed-314"],
            fold_lineage: ["5-fold"],
            postprocess_lineage: [],
          },
          metrics: [{ label: "balanced_accuracy", value: 0.97001, direction: "maximize", confidence: 0.9 }],
          artifacts: [],
          similarity: [{ candidate_id: "raw-best-threshold", similarity: 0.42, signal: "metric_correlation" }],
          robustness: {
            stability_score: 0.88,
            risk_penalty: 0.02,
            evidence_confidence: 0.9,
            weak_dimensions: ["minority_class_recall"],
            provenance_refs: ["runs/weak-class/metrics.json", "runs/weak-class/per-class.json"],
            summary: "Misses raw best but improves minority class recall under plateau.",
          },
          near_miss: {
            status: "retained",
            reason_to_keep: ["weak_dimension_improvement", "stability", "complementarity"],
            weak_dimensions: ["minority_class_recall"],
            complementary_candidate_ids: ["raw-best-threshold"],
            follow_up: {
              title: "Expand minority class weighting follow-up",
              rationale: "Use the weak-class gain to test a larger class-weight schedule.",
              target_dimensions: ["minority_class_recall", "balanced_accuracy"],
              expected_evidence_gain: "Confirms whether the weak-dimension improvement survives a larger run.",
            },
            evidence_refs: ["runs/weak-class/per-class.json"],
            summary: "Retained because it improves the weak class while staying near raw best.",
          },
          disposition: "retained",
          disposition_reason: "Near miss retained for weak-dimension improvement.",
        },
        {
          candidate_id: "tabnet-diverse-near-miss",
          label: "TabNet diverse near miss",
          lineage: {
            strategy_family: "tabnet",
            feature_lineage: ["encoded-categorical"],
            model_lineage: ["tabnet"],
            config_lineage: ["smoke"],
            seed_lineage: ["seed-7"],
            fold_lineage: ["5-fold"],
            postprocess_lineage: [],
          },
          metrics: [{ label: "balanced_accuracy", value: 0.962, direction: "maximize", confidence: 0.82 }],
          artifacts: [],
          similarity: [{ candidate_id: "raw-best-threshold", similarity: 0.28, signal: "declared" }],
          robustness: {
            stability_score: 0.76,
            risk_penalty: 0.03,
            evidence_confidence: 0.82,
            weak_dimensions: [],
            provenance_refs: ["runs/tabnet-smoke/metrics.json"],
            summary: "Lower score but a distinct strategy family with cheap follow-up potential.",
          },
          near_miss: {
            status: "retained",
            reason_to_keep: ["novelty"],
            weak_dimensions: [],
            complementary_candidate_ids: [],
            follow_up: {
              title: "Promote TabNet smoke to a bounded larger fold run",
              rationale: "The distinct family can test whether the plateau is model-family specific.",
              target_dimensions: ["balanced_accuracy"],
            },
            evidence_refs: ["runs/tabnet-smoke/metrics.json"],
            summary: "Distinct strategy family kept despite lower local score.",
          },
          disposition: "retained",
          disposition_reason: "Distinct strategy family preserved for stall recovery.",
        },
      ],
      summary: "Stalled candidate snapshot with promising non-winners.",
      outcome: "continued",
    });

    const summary = await ledger.summarizeGoal("goal-near-miss-stall");

    expect(summary.candidate_selection_summary.raw_best?.candidate_id).toBe("raw-best-threshold");
    expect(summary.near_miss_candidates.map((candidate) => candidate.candidate_id)).toEqual([
      "weak-class-near-miss",
      "tabnet-diverse-near-miss",
    ]);
    expect(summary.near_miss_candidates[0]).toMatchObject({
      candidate_id: "weak-class-near-miss",
      raw_best_candidate_id: "raw-best-threshold",
      reason_to_keep: expect.arrayContaining(["weak_dimension_improvement", "stability", "complementarity"]),
      weak_dimensions: ["minority_class_recall"],
      follow_up: {
        title: "Expand minority class weighting follow-up",
      },
    });
    expect(summary.near_miss_candidates[1]).toMatchObject({
      candidate_id: "tabnet-diverse-near-miss",
      strategy_family: "tabnet",
      reason_to_keep: expect.arrayContaining(["novelty"]),
    });
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
        active_hypotheses: [{
          hypothesis: "Bounded ablation separates search saturation from model saturation.",
          supporting_evidence_ref: "metric:accuracy",
          target_metric_or_dimension: "accuracy",
          expected_next_observation: "Accuracy changes after one-factor ablation.",
          status: "testing",
        }],
        rejected_approaches: [{
          approach: "repeat baseline threshold sweep",
          rejection_reason: "Three previous sweeps did not move accuracy.",
          evidence_ref: "lineage:baseline-threshold-sweep",
          revisit_condition: "new validation split exposes threshold instability",
          confidence: 0.84,
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
      active_hypotheses: [{
        target_metric_or_dimension: "accuracy",
        status: "testing",
      }],
      rejected_approaches: [{
        approach: "repeat baseline threshold sweep",
        evidence_ref: "lineage:baseline-threshold-sweep",
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
