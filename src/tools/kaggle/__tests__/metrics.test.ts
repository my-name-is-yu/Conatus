import { describe, expect, it } from "vitest";
import { KaggleMetricsSchema, metricThresholdHintForDirection, parseKaggleMetricsCompatible } from "../metrics.js";

describe("Kaggle metrics helpers", () => {
  it("maps maximize metrics to gte threshold hints", () => {
    expect(metricThresholdHintForDirection("accuracy", "maximize")).toMatchObject({
      wait_condition_type: "metric_threshold",
      metric: "accuracy",
      operator: "gte",
      value_required: true,
      metric_source: "wait_metadata.metrics",
    });
  });

  it("maps minimize metrics to lte threshold hints", () => {
    expect(metricThresholdHintForDirection("rmse", "minimize")).toMatchObject({
      wait_condition_type: "metric_threshold",
      metric: "rmse",
      operator: "lte",
      value_required: true,
      metric_source: "wait_metadata.metrics",
    });
  });

  it("accepts only the strict metrics contract", () => {
    const valid = {
      experiment_id: "exp-20260425-001",
      competition: "titanic",
      metric_name: "rmse",
      direction: "minimize",
      cv_score: 0.123,
      cv_std: 0.004,
      holdout_score: null,
      train_rows: 1000,
      valid_rows: 200,
      seed: 42,
      created_at: "2026-04-25T00:00:00.000Z",
      status: "completed",
      artifacts: {
        model: "experiments/exp-20260425-001/model.pkl",
        submission: "experiments/exp-20260425-001/submission.csv",
        log: "experiments/exp-20260425-001/train.log",
      },
    };

    expect(KaggleMetricsSchema.safeParse(valid).success).toBe(true);
    expect(KaggleMetricsSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(KaggleMetricsSchema.safeParse({ ...valid, direction: "higher" }).success).toBe(false);
  });

  it("normalizes loose real-run metrics into the strict comparison shape", () => {
    const result = parseKaggleMetricsCompatible({
      metric_name: "balanced_accuracy",
      metric_value: 0.813,
      metric_direction: "higher_is_better",
      all_metrics: {
        balanced_accuracy: 0.813,
      },
      started_at_utc: "2026-04-28T01:02:03Z",
    }, {
      experiment_id: "exp-real",
      competition: "playground-series-s6e4",
      log_path: "experiments/exp-real/train.log",
    });

    expect(result).toMatchObject({
      ok: true,
      source_schema: "loose",
      metrics: {
        experiment_id: "exp-real",
        competition: "playground-series-s6e4",
        metric_name: "balanced_accuracy",
        direction: "maximize",
        cv_score: 0.813,
        train_rows: 0,
        valid_rows: 0,
        artifacts: { log: "experiments/exp-real/train.log" },
      },
    });
    expect(result.ok && result.warnings).toEqual(expect.arrayContaining([
      "competition was supplied by the caller",
      "train_rows missing; normalized to 0",
      "valid_rows missing; normalized to 0",
    ]));
  });
});
