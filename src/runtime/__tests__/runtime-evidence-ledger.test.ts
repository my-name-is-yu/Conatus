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
});
