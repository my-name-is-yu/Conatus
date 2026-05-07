import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calculateGapOrComplete } from "../durable-loop/preparation.js";
import type { PhaseCtx } from "../durable-loop/preparation.js";
import type { LoopIterationResult } from "../durable-loop/contracts.js";
import type { Goal } from "../../../base/types/goal.js";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
});

function makeMechanicalDimension(endpoint = "node -e \"console.log(42)\"") {
  return {
    name: "workspace metric",
    label: "Workspace metric",
    threshold: { type: "min" as const, value: 80 },
    current_value: 1,
    confidence: 0.2,
    weight: 1,
    last_updated: new Date().toISOString(),
    observation_method: {
      type: "mechanical" as const,
      source: endpoint,
      schedule: null,
      endpoint,
      confidence_tier: "mechanical" as const,
    },
    history: [],
    uncertainty_weight: null,
    state_integrity: "ok" as const,
    dimension_mapping: null,
  };
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-workspace-refresh",
    title: "Refresh workspace metric",
    description: "Refresh a stale low-confidence dimension",
    dimensions: [makeMechanicalDimension()],
    gap_aggregation: "max",
    uncertainty_weight: 1,
    status: "active",
    origin: "manual",
    children_ids: [],
    constraints: [],
    deadline: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
    parent_id: overrides.parent_id ?? null,
    node_type: overrides.node_type ?? "goal",
    dimension_mapping: overrides.dimension_mapping ?? null,
  } as Goal;
}

function makeResult(): LoopIterationResult {
  return {
    loopIndex: 0,
    goalId: "goal-workspace-refresh",
    gapAggregate: 0,
    driveScores: [],
    taskResult: null,
    stallDetected: false,
    stallReport: null,
    pivotOccurred: false,
    completionJudgment: {
      is_complete: false,
      blocking_dimensions: [],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: new Date().toISOString(),
    },
    elapsedMs: 0,
    error: null,
  };
}

function makePhaseCtx(calls: Array<{ toolName: string; input: unknown; cwd: string }>): PhaseCtx {
  const gapCalculator = {
    calculateGapVector: vi.fn().mockReturnValue({
      goal_id: "goal-workspace-refresh",
      gaps: [],
      timestamp: new Date().toISOString(),
    }),
    aggregateGaps: vi.fn().mockReturnValue(0),
  };
  const satisficingJudge = {
    isGoalComplete: vi.fn().mockReturnValue({
      is_complete: false,
      blocking_dimensions: [],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: new Date().toISOString(),
    }),
    judgeTreeCompletion: vi.fn(),
  };
  const stateManager = {
    saveGoal: vi.fn().mockResolvedValue(undefined),
    appendGapHistoryEntry: vi.fn().mockResolvedValue(undefined),
    loadGapHistory: vi.fn().mockResolvedValue([]),
  };
  const toolExecutor = {
    execute: vi.fn(async (toolName: string, input: unknown, context: { cwd: string }) => {
      calls.push({ toolName, input, cwd: context.cwd });
      return {
        success: true,
        data: { stdout: "42\n", stderr: "", exitCode: 0 },
        summary: "measured",
      };
    }),
  };

  return {
    deps: {
      gapCalculator,
      satisficingJudge,
      stateManager,
    } as unknown as PhaseCtx["deps"],
    config: {} as PhaseCtx["config"],
    logger: undefined,
    toolExecutor: toolExecutor as unknown as PhaseCtx["toolExecutor"],
  };
}

describe("calculateGapOrComplete stale dimension direct measurement cwd", () => {
  it("uses goal workspace_path for relative mechanical measurement when daemon cwd differs", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-gap-refresh-workspace-"));
    const daemonCwd = path.join(root, "daemon");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(daemonCwd);
    fs.mkdirSync(workspace);
    process.chdir(daemonCwd);

    const calls: Array<{ toolName: string; input: unknown; cwd: string }> = [];
    const ctx = makePhaseCtx(calls);
    const goal = makeGoal({ constraints: [`workspace_path:${workspace}`] });

    await calculateGapOrComplete(ctx, goal.id, goal, 0, makeResult(), Date.now());

    expect(calls).toEqual([
      {
        toolName: "shell",
        input: { command: "node -e \"console.log(42)\"", timeoutMs: 30_000 },
        cwd: workspace,
      },
    ]);
    expect(fs.realpathSync(calls[0]!.cwd)).not.toBe(fs.realpathSync(daemonCwd));
    expect(goal.dimensions[0]!.current_value).toBe(42);
  });

  it("falls back to daemon cwd only when no goal workspace_path is available", async () => {
    const daemonCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-gap-refresh-daemon-"));
    process.chdir(daemonCwd);

    const calls: Array<{ toolName: string; input: unknown; cwd: string }> = [];
    const ctx = makePhaseCtx(calls);
    const goal = makeGoal();

    await calculateGapOrComplete(ctx, goal.id, goal, 0, makeResult(), Date.now());

    expect(calls).toHaveLength(1);
    expect(fs.realpathSync(calls[0]!.cwd)).toBe(fs.realpathSync(daemonCwd));
  });
});
