import { describe, expect, it } from "vitest";

import { makeGoal } from "../../../../tests/helpers/fixtures.js";
import type { DeadlineFinalizationStatus } from "../../../platform/time/deadline-finalization.js";
import type { MetricTrendContext } from "../../../platform/drive/metric-history.js";
import { makeEmptyIterationResult } from "../loop-result-types.js";
import {
  buildDreamReviewCheckpointRequest,
} from "../core-loop/dream-review-checkpoint.js";
import { DreamReviewCheckpointEvidenceSchema } from "../core-loop/phase-specs.js";

function makeMetricTrendContext(overrides: Partial<MetricTrendContext> = {}): MetricTrendContext {
  return {
    metric_key: "dim1",
    direction: "maximize",
    trend: "stalled",
    latest_value: 0.7,
    latest_observed_at: "2026-04-30T00:05:00.000Z",
    best_value: 0.7,
    best_observed_at: "2026-04-30T00:00:00.000Z",
    observation_count: 6,
    recent_slope_per_observation: 0,
    best_delta: 0,
    last_meaningful_improvement_delta: null,
    last_breakthrough_delta: null,
    time_since_last_meaningful_improvement_ms: null,
    improvement_threshold: 0.01,
    breakthrough_threshold: 0.05,
    noise_band: 0.005,
    confidence: 0.9,
    source_refs: [{ entry_id: "entry-1", kind: "metric" }],
    summary: "dim1 trend is stalled",
    ...overrides,
  };
}

function makeFinalizationStatus(overrides: Partial<DeadlineFinalizationStatus> = {}): DeadlineFinalizationStatus {
  return {
    mode: "finalization",
    deadline: "2026-04-30T01:00:00.000Z",
    evaluated_at: "2026-04-30T00:30:00.000Z",
    remaining_ms: 30 * 60 * 1000,
    reserved_finalization_ms: 30 * 60 * 1000,
    remaining_exploration_ms: 0,
    consolidation_buffer_ms: 0,
    finalization_plan: null,
    reason: "Reserved finalization buffer has started.",
    ...overrides,
  };
}

describe("Dream review checkpoint trigger planning", () => {
  it("requests a bounded iteration checkpoint on cadence", () => {
    const request = buildDreamReviewCheckpointRequest({
      goal: makeGoal(),
      loopIndex: 3,
      result: makeEmptyIterationResult("goal-1", 3),
      driveScores: [],
    });

    expect(request).toMatchObject({
      trigger: "iteration",
      memoryAuthorityPolicy: "soil_and_playbooks_are_advisory_only",
      activeDimensions: ["dim1"],
      maxGuidanceItems: 3,
    });
  });

  it("rate-limits repeated non-finalization checkpoints", () => {
    const request = buildDreamReviewCheckpointRequest({
      goal: makeGoal(),
      loopIndex: 3,
      result: makeEmptyIterationResult("goal-1", 3),
      driveScores: [],
      recentCheckpoints: [{
        trigger: "plateau",
        summary: "Recent checkpoint",
        current_goal: "Test Goal",
        active_dimensions: ["dim1"],
        recent_strategy_families: [],
        exhausted: [],
        promising: [],
        relevant_memories: [],
        next_strategy_candidates: [],
        guidance: "Try one bounded variant.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.8,
        entry_id: "entry-checkpoint",
        occurred_at: "2026-04-30T00:00:00.000Z",
        loop_index: 2,
      }],
    });

    expect(request).toBeNull();
  });

  it("uses plateau and breakthrough metric trends as checkpoint triggers", () => {
    const plateau = buildDreamReviewCheckpointRequest({
      goal: makeGoal(),
      loopIndex: 1,
      result: makeEmptyIterationResult("goal-1", 1, {
        metricTrendContext: makeMetricTrendContext({ trend: "regressing", summary: "metric regressed" }),
      }),
      driveScores: [],
    });
    const breakthrough = buildDreamReviewCheckpointRequest({
      goal: makeGoal(),
      loopIndex: 1,
      result: makeEmptyIterationResult("goal-1", 1, {
        metricTrendContext: makeMetricTrendContext({ trend: "breakthrough", summary: "metric broke through" }),
      }),
      driveScores: [],
    });

    expect(plateau).toMatchObject({ trigger: "plateau", metricTrendSummary: "metric regressed" });
    expect(breakthrough).toMatchObject({ trigger: "breakthrough", metricTrendSummary: "metric broke through" });
  });

  it("runs pre-finalization checkpoints even when a recent checkpoint exists", () => {
    const request = buildDreamReviewCheckpointRequest({
      goal: makeGoal(),
      loopIndex: 3,
      result: makeEmptyIterationResult("goal-1", 3),
      driveScores: [],
      finalizationStatus: makeFinalizationStatus(),
      recentCheckpoints: [{
        trigger: "iteration",
        summary: "Recent checkpoint",
        current_goal: "Test Goal",
        active_dimensions: ["dim1"],
        recent_strategy_families: [],
        exhausted: [],
        promising: [],
        relevant_memories: [],
        next_strategy_candidates: [],
        guidance: "Try one bounded variant.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.8,
        entry_id: "entry-checkpoint",
        occurred_at: "2026-04-30T00:00:00.000Z",
        loop_index: 2,
      }],
    });

    expect(request).toMatchObject({
      trigger: "pre_finalization",
      finalizationReason: "Reserved finalization buffer has started.",
    });
  });

  it("rate-limits repeated pre-finalization checkpoints", () => {
    const request = buildDreamReviewCheckpointRequest({
      goal: makeGoal(),
      loopIndex: 3,
      result: makeEmptyIterationResult("goal-1", 3),
      driveScores: [],
      finalizationStatus: makeFinalizationStatus(),
      recentCheckpoints: [{
        trigger: "pre_finalization",
        summary: "Recent checkpoint",
        current_goal: "Test Goal",
        active_dimensions: ["dim1"],
        recent_strategy_families: [],
        exhausted: [],
        promising: [],
        relevant_memories: [],
        next_strategy_candidates: [],
        guidance: "Try one bounded variant.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.8,
        entry_id: "entry-checkpoint",
        occurred_at: "2026-04-30T00:00:00.000Z",
        loop_index: 2,
      }],
    });

    expect(request).toBeNull();
  });

  it("requires retrieved Soil and playbook memories to remain advisory-only", () => {
    const parsed = DreamReviewCheckpointEvidenceSchema.safeParse({
      summary: "Checkpoint summary",
      trigger: "plateau",
      current_goal: "Test Goal",
      active_dimensions: ["dim1"],
      relevant_memories: [{
        source_type: "soil",
        ref: "soil://memory/a",
        summary: "Prior run note",
        authority: "executable",
      }],
      guidance: "Try a bounded variant.",
      context_authority: "advisory_only",
      confidence: 0.8,
    });

    expect(parsed.success).toBe(false);
  });
});
