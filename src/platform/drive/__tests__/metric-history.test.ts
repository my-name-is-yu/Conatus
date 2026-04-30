import { describe, expect, it } from "vitest";
import { classifyMetricTrend, type MetricObservation } from "../metric-history.js";

function observations(values: number[]): MetricObservation[] {
  return values.map((value, index) => ({
    observed_at: new Date(Date.UTC(2026, 3, 30, 0, index, 0)).toISOString(),
    metric_key: "accuracy",
    value,
    direction: "maximize",
    confidence: 1,
    source: { entry_id: `entry-${index}`, kind: "metric" },
  }));
}

describe("classifyMetricTrend", () => {
  it("classifies monotonic improvement", () => {
    const trend = classifyMetricTrend(observations([0.4, 0.45, 0.5, 0.56]), {
      improvementThreshold: 0.02,
      breakthroughThreshold: 0.2,
    });

    expect(trend?.trend).toBe("improving");
    expect(trend?.best_value).toBe(0.56);
  });

  it("classifies a flat stall", () => {
    const trend = classifyMetricTrend(observations([0.7, 0.7, 0.7, 0.7]), {
      improvementThreshold: 0.02,
    });

    expect(trend?.trend).toBe("stalled");
  });

  it("classifies an early breakthrough followed by a plateau as stalled", () => {
    const trend = classifyMetricTrend(observations([0.45, 0.96, 0.961, 0.9605, 0.9607]), {
      improvementThreshold: 0.01,
      breakthroughThreshold: 0.1,
      noiseBand: 0.002,
    });

    expect(trend?.trend).toBe("stalled");
    expect(trend?.best_value).toBe(0.961);
  });

  it("classifies small noise as inconclusive instead of improvement", () => {
    const trend = classifyMetricTrend(observations([0.7, 0.704, 0.699, 0.703]), {
      improvementThreshold: 0.02,
      noiseBand: 0.01,
    });

    expect(trend?.trend).toBe("noisy");
  });

  it("classifies regression", () => {
    const trend = classifyMetricTrend(observations([0.76, 0.72, 0.69, 0.66]), {
      improvementThreshold: 0.02,
    });

    expect(trend?.trend).toBe("regressing");
  });

  it("classifies meaningful drawdown after a breakthrough as regression", () => {
    const trend = classifyMetricTrend(observations([0.45, 0.96, 0.955, 0.94, 0.93]), {
      improvementThreshold: 0.01,
      breakthroughThreshold: 0.1,
    });

    expect(trend?.trend).toBe("regressing");
    expect(trend?.best_value).toBe(0.96);
    expect(trend?.latest_value).toBe(0.93);
  });

  it("classifies a large breakthrough jump", () => {
    const trend = classifyMetricTrend(observations([0.51, 0.52, 0.53, 0.76]), {
      improvementThreshold: 0.02,
      breakthroughThreshold: 0.1,
    });

    expect(trend?.trend).toBe("breakthrough");
    expect(trend?.last_breakthrough_delta).toBeCloseTo(0.23);
  });
});
