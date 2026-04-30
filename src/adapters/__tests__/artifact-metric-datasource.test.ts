import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir } from "../../../tests/helpers/temp-dir.js";
import { makeDimension, makeGoal } from "../../../tests/helpers/fixtures.js";
import { StateManager } from "../../base/state/state-manager.js";
import { ObservationEngine } from "../../platform/observation/observation-engine.js";
import {
  ArtifactMetricDataSourceAdapter,
  createWorkspaceArtifactMetricDataSource,
} from "../datasources/artifact-metric-datasource.js";

describe("ArtifactMetricDataSourceAdapter", () => {
  let tmpDir: string;
  let workspace: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
    workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("scans nested workspace metrics and selects the best metric value", async () => {
    writeJson(path.join(workspace, "artifacts", "probe_balanced_default", "metrics.json"), {
      oof_balanced_accuracy: 0.9623128530945794,
    });
    writeJson(path.join(workspace, "artifacts", "probe_sweep", "base_d7_lr007_i700_l26", "metrics.json"), {
      metrics: { balanced_accuracy: 0.94 },
    });
    writeJson(path.join(workspace, "artifacts", "experiments", "older", "metrics.json"), {
      all_metrics: { balanced_accuracy: 0.91 },
    });
    writeJson(path.join(workspace, "data", "raw", "ignored", "metrics.json"), {
      oof_balanced_accuracy: 0.99,
    });
    writeJson(path.join(workspace, ".venv", "ignored", "metrics.json"), {
      oof_balanced_accuracy: 0.98,
    });

    const adapter = createWorkspaceArtifactMetricDataSource(workspace);
    const result = await adapter.query({ dimension_name: "best_oof_balanced_accuracy", timeout_ms: 10000 });

    expect(result.value).toBe(0.9623128530945794);
    expect(result.raw).toMatchObject({
      inspected_metric_files: 3,
      selected_key: "oof_balanced_accuracy",
      selected: {
        path: path.join(workspace, "artifacts", "probe_balanced_default", "metrics.json"),
        keyPath: "oof_balanced_accuracy",
        parser: "json",
        extractionConfidence: 0.95,
        stale: false,
      },
      strategic_correctness: "not_evaluated",
    });
  });

  it("counts validated metric artifacts when no experiment log exists", async () => {
    writeJson(path.join(workspace, "artifacts", "probe-a", "metrics.json"), { score: 0.8 });
    writeJson(path.join(workspace, "artifacts", "probe-b", "metrics.json"), { metrics: { accuracy: 0.7 } });
    writeJson(path.join(workspace, "artifacts", "broken", "metrics.json"), { notes: "no numeric metrics" });

    const adapter = createWorkspaceArtifactMetricDataSource(workspace);
    const result = await adapter.query({ dimension_name: "validated_experiment_count", timeout_ms: 10000 });

    expect(result.value).toBe(2);
    expect(result.raw).toMatchObject({
      inspected_metric_files: 3,
      matched_metric_files: 2,
      strategic_correctness: "not_evaluated",
    });
  });

  it("updates CoreLoop-observed goal dimensions through ObservationEngine.observe", async () => {
    writeJson(path.join(workspace, "artifacts", "probe-balanced", "metrics.json"), {
      oof_balanced_accuracy: 0.88,
    });
    const stateManager = new StateManager(tmpDir);
    const goal = makeGoal({
      id: "goal-artifact-metrics",
      constraints: [`workspace_path:${workspace}`],
      dimensions: [
        makeDimension({
          name: "best_oof_balanced_accuracy",
          label: "Best OOF balanced accuracy",
          current_value: 0,
          threshold: { type: "min", value: 0.95 },
        }),
      ],
    });
    await stateManager.saveGoal(goal);

    const engine = new ObservationEngine(stateManager, [createWorkspaceArtifactMetricDataSource(workspace)]);
    await engine.observe("goal-artifact-metrics", []);

    const updated = await stateManager.loadGoal("goal-artifact-metrics");
    expect(updated?.dimensions[0]?.current_value).toBe(0.88);
    expect(updated?.dimensions[0]?.last_observed_layer).toBe("mechanical");
  });

  it("does not claim unrelated best-prefixed dimensions in the CoreLoop observation path", async () => {
    const stateManager = new StateManager(tmpDir);
    const goal = makeGoal({
      id: "goal-non-metric-best",
      constraints: [`workspace_path:${workspace}`],
      dimensions: [
        makeDimension({
          name: "best_next_action",
          label: "Best next action",
          current_value: "investigate",
          threshold: { type: "present" },
        }),
      ],
    });
    await stateManager.saveGoal(goal);

    const engine = new ObservationEngine(stateManager, [createWorkspaceArtifactMetricDataSource(workspace)]);
    await engine.observe("goal-non-metric-best", []);

    const updated = await stateManager.loadGoal("goal-non-metric-best");
    expect(updated?.dimensions[0]?.current_value).toBe("investigate");
    expect(updated?.dimensions[0]?.last_observed_layer).toBeUndefined();
  });

  it("supports explicit metric keys and lower-is-better aggregation", async () => {
    writeJson(path.join(workspace, "runs", "a", "result.json"), {
      evidence: [{ kind: "metric", label: "validation_loss", value: 0.42 }],
    });
    writeJson(path.join(workspace, "runs", "b", "result.json"), {
      evidence: [{ kind: "metric", label: "validation_loss", value: 0.31 }],
    });
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "loss-artifacts",
      name: "loss artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        dimension_metrics: { best_validation_loss: ["validation_loss"] },
        dimension_aggregations: { best_validation_loss: "min" },
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "best_validation_loss", timeout_ms: 10000 });

    expect(result.value).toBe(0.31);
    expect(result.raw).toMatchObject({
      selected_key: "validation_loss",
    });
  });

  it("discovers configured include paths without requiring a predeclared exact metric file path", async () => {
    writeJson(path.join(workspace, "custom", "nested", "trial-a", "metrics.json"), {
      metrics: { accuracy: 0.81 },
    });
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "custom-artifacts",
      name: "Custom artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        include_paths: ["custom/nested"],
        dimension_metrics: { best_accuracy: ["accuracy"] },
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "best_accuracy", timeout_ms: 10000 });

    expect(result.value).toBe(0.81);
    expect(result.raw).toMatchObject({
      inspected_metric_files: 1,
      selected: {
        relativePath: "custom/nested/trial-a/metrics.json",
        key: "accuracy",
      },
    });
  });

  it("does not let stale higher values silently override fresh evidence", async () => {
    const stalePath = path.join(workspace, "artifacts", "old", "metrics.json");
    const freshPath = path.join(workspace, "artifacts", "fresh", "metrics.json");
    writeJson(stalePath, { score: 0.99 });
    writeJson(freshPath, { score: 0.75 });
    setModifiedTime(stalePath, new Date(Date.now() - 60_000));
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "stale-artifacts",
      name: "Stale artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        stale_after_ms: 1_000,
        dimension_metrics: { best_score: ["score"] },
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "best_score", timeout_ms: 10000 });

    expect(result.value).toBe(0.75);
    expect(result.raw).toMatchObject({
      selected: {
        path: freshPath,
        stale: false,
      },
      stale_candidates: [
        {
          path: "artifacts/old/metrics.json",
        },
      ],
    });
  });

  it("surfaces conflicting metric candidates instead of treating one as uncontested truth", async () => {
    writeJson(path.join(workspace, "artifacts", "a", "metrics.json"), { score: 0.4 });
    writeJson(path.join(workspace, "artifacts", "b", "metrics.json"), { score: 0.6 });
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "conflict-artifacts",
      name: "Conflict artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        dimension_metrics: { best_score: ["score"] },
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "best_score", timeout_ms: 10000 });

    expect(result.value).toBe(0.6);
    expect(result.raw).toMatchObject({
      conflicts: [
        {
          metricKey: "score",
        },
      ],
    });
    const raw = result.raw as { conflicts?: Array<{ candidates?: unknown[] }> };
    expect(raw.conflicts?.[0]?.candidates).toHaveLength(2);
  });

  it("surfaces alias conflicts for one requested dimension", async () => {
    writeJson(path.join(workspace, "artifacts", "a", "metrics.json"), { score: 0.4 });
    writeJson(path.join(workspace, "artifacts", "b", "metrics.json"), { cv_score: 0.6 });
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "alias-conflict-artifacts",
      name: "Alias conflict artifacts",
      type: "artifact_metric",
      connection: { path: workspace },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "best_score", timeout_ms: 10000 });

    expect(result.raw).toMatchObject({
      conflicts: expect.arrayContaining([
        expect.objectContaining({
          metricKey: "dimension:best_score",
        }),
      ]),
    });
  });

  it("returns missing artifact evidence without falling back to a strategy conclusion", async () => {
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "missing-artifacts",
      name: "Missing artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        dimension_metrics: { best_score: ["score"] },
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "best_score", timeout_ms: 10000 });

    expect(result.value).toBe(0);
    expect(result.raw).toMatchObject({
      inspected_metric_files: 0,
      selected: null,
      candidates: [],
      evidence_candidates: [],
      strategic_correctness: "not_evaluated",
    });
  });

  it("keeps extraction confidence separate from strategic correctness for lower-confidence evidence arrays", async () => {
    writeJson(path.join(workspace, "reports", "trial", "result.json"), {
      evidence: [{ kind: "metric", label: "validation_score", value: 0.62 }],
    });
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "evidence-artifacts",
      name: "Evidence artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        dimension_metrics: { best_validation_score: ["validation_score"] },
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "best_validation_score", timeout_ms: 10000 });

    expect(result.value).toBe(0.62);
    expect(result.raw).toMatchObject({
      selected: {
        key: "validation_score",
        keyPath: "evidence.0.value",
        extractionConfidence: 0.8,
      },
      evidence_candidates: [
        {
          extraction_confidence: 0.8,
          strategic_correctness: "not_evaluated",
        },
      ],
      strategic_correctness: "not_evaluated",
    });
  });

  it("orders evidence candidates by lower-is-better aggregation for loss dimensions", async () => {
    writeJson(path.join(workspace, "runs", "bad", "result.json"), {
      metrics: { validation_loss: 0.8 },
    });
    writeJson(path.join(workspace, "runs", "good", "result.json"), {
      metrics: { validation_loss: 0.2 },
    });
    const adapter = new ArtifactMetricDataSourceAdapter({
      id: "loss-evidence-artifacts",
      name: "Loss evidence artifacts",
      type: "artifact_metric",
      connection: {
        path: workspace,
        dimension_metrics: { best_validation_loss: ["validation_loss"] },
        dimension_aggregations: { best_validation_loss: "min" },
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    const result = await adapter.query({ dimension_name: "best_validation_loss", timeout_ms: 10000 });

    expect(result.value).toBe(0.2);
    const raw = result.raw as { evidence_candidates?: Array<{ value?: number }> };
    expect(raw.evidence_candidates?.[0]?.value).toBe(0.2);
  });
});

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function setModifiedTime(filePath: string, date: Date): void {
  fs.utimesSync(filePath, date, date);
}
