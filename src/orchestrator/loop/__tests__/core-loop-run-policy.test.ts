import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreLoop, makeEmptyIterationResult, type CoreLoopDeps } from "../core-loop.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";
import { RuntimeBudgetStore } from "../../../runtime/store/budget-store.js";

function makeDeps(): CoreLoopDeps {
  return {
    stateManager: {
      loadGoal: vi.fn(async (goalId: string) => makeGoal({ id: goalId, status: "active", dimensions: [] })),
      saveGoal: vi.fn(),
      archiveGoal: vi.fn(),
      restoreFromCheckpoint: vi.fn(async () => 0),
    },
    stallDetector: {
      resetEscalation: vi.fn(),
    },
    strategyManager: {
      setStrategyTemplateRegistry: vi.fn(),
    },
    hookManager: {
      emit: vi.fn(),
      getDreamCollector: vi.fn(() => null),
    },
  } as unknown as CoreLoopDeps;
}

describe("CoreLoop run policies", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("keeps bounded maxIterations as a lifecycle cap", async () => {
    const loop = new CoreLoop(makeDeps(), {
      maxIterations: 2,
      delayBetweenLoopsMs: 0,
      dryRun: true,
      autoDecompose: false,
    });
    vi.spyOn(loop, "runOneIteration").mockImplementation(async (goalId, loopIndex) =>
      makeEmptyIterationResult(goalId, loopIndex)
    );

    const result = await loop.run("goal-bounded");

    expect(result.finalStatus).toBe("max_iterations");
    expect(result.totalIterations).toBe(2);
  });

  it("lets resident runs continue without an iteration-count lifecycle cap until explicitly stopped", async () => {
    const loop = new CoreLoop(makeDeps(), {
      maxIterations: null,
      runPolicy: "resident",
      delayBetweenLoopsMs: 0,
      dryRun: true,
      autoDecompose: false,
    });
    vi.spyOn(loop, "runOneIteration").mockImplementation(async (goalId, loopIndex) => {
      if (loopIndex === 2) {
        loop.stop();
      }
      return makeEmptyIterationResult(goalId, loopIndex);
    });

    const result = await loop.run("goal-resident");

    expect(result.finalStatus).toBe("stopped");
    expect(result.totalIterations).toBe(3);
  });

  it("treats a maxIterations null run override as resident even on a bounded loop", async () => {
    const loop = new CoreLoop(makeDeps(), {
      maxIterations: 100,
      delayBetweenLoopsMs: 0,
      dryRun: true,
      autoDecompose: false,
    });
    vi.spyOn(loop, "runOneIteration").mockImplementation(async (goalId, loopIndex) => {
      if (loopIndex === 1) {
        loop.stop();
      }
      return makeEmptyIterationResult(goalId, loopIndex);
    });

    const result = await loop.run("goal-null-override", { maxIterations: null });

    expect(result.finalStatus).toBe("stopped");
    expect(result.totalIterations).toBe(2);
  });

  it("persists runtime budget usage from the CoreLoop caller path", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-core-budget-"));
    tempDirs.push(tempDir);
    const runtimeBudgetStore = new RuntimeBudgetStore(path.join(tempDir, "runtime"));
    const deps = {
      ...makeDeps(),
      runtimeBudgetStore,
      reportingEngine: { generateExecutionSummary: vi.fn(), saveReport: vi.fn() },
    } as unknown as CoreLoopDeps;
    const loop = new CoreLoop(deps, {
      maxIterations: 2,
      delayBetweenLoopsMs: 0,
      autoDecompose: false,
      runtimeBudget: {
        budgetId: "budget-coreloop-test",
        limits: [
          { dimension: "iterations", limit: 2 },
          { dimension: "tasks", limit: 2 },
          { dimension: "wall_clock_ms", limit: 1000 },
          { dimension: "process_ms", limit: 1000 },
          { dimension: "llm_tokens", limit: 1000 },
          { dimension: "artifacts", limit: 4 },
        ],
      },
    });
    vi.spyOn(loop, "runOneIteration").mockImplementation(async (goalId, loopIndex) =>
      makeEmptyIterationResult(goalId, loopIndex, {
        elapsedMs: 25,
        tokensUsed: 123,
        taskResult: {
          action: "completed",
          task: {
            id: `task-${loopIndex}`,
            goal_id: goalId,
            strategy_id: null,
            target_dimensions: [],
            primary_dimension: "quality",
            work_description: "Do work",
            rationale: "Needed",
            approach: "Patch",
            success_criteria: [],
            scope_boundary: { in_scope: [], out_of_scope: [], blast_radius: "" },
            constraints: [],
            plateau_until: null,
            estimated_duration: null,
            consecutive_failure_count: 0,
            reversibility: "unknown",
            status: "completed",
            started_at: null,
            completed_at: null,
            timeout_at: null,
            heartbeat_at: null,
            created_at: new Date().toISOString(),
            task_category: "normal",
          },
          verificationResult: {
            task_id: `task-${loopIndex}`,
            verdict: "pass",
            confidence: 1,
            evidence: [],
            dimension_updates: [],
            file_diffs: [{ path: `artifact-${loopIndex}.diff`, patch: "+x" }],
            timestamp: new Date().toISOString(),
          },
          tokensUsed: 123,
        },
      })
    );

    await loop.run("goal-budgeted");

    const budget = await runtimeBudgetStore.load("budget-coreloop-test");
    const status = runtimeBudgetStore.status(budget!);
    expect(status.dimensions).toContainEqual(expect.objectContaining({ dimension: "iterations", used: 2, remaining: 0 }));
    expect(status.dimensions).toContainEqual(expect.objectContaining({ dimension: "tasks", used: 2, remaining: 0 }));
    expect(status.dimensions).toContainEqual(expect.objectContaining({ dimension: "wall_clock_ms", used: 50, remaining: 950 }));
    expect(status.dimensions).toContainEqual(expect.objectContaining({ dimension: "process_ms", used: 50, remaining: 950 }));
    expect(status.dimensions).toContainEqual(expect.objectContaining({ dimension: "llm_tokens", used: 246, remaining: 754 }));
    expect(status.dimensions).toContainEqual(expect.objectContaining({ dimension: "artifacts", used: 2, remaining: 2 }));
  });

  it("enforces stop exhaustion policy without asking for approval", async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-core-budget-stop-"));
    tempDirs.push(tempDir);
    const runtimeBudgetStore = new RuntimeBudgetStore(path.join(tempDir, "runtime"));
    await runtimeBudgetStore.create({
      budget_id: "budget-stop-policy",
      scope: { goal_id: "goal-budget-stop" },
      created_at: "2026-05-01T00:00:00.000Z",
      limits: [{ dimension: "iterations", limit: 1, exhaustion_policy: "stop" }],
    });
    await runtimeBudgetStore.recordTaskExecution("budget-stop-policy", { iterations: 1 });
    const waitApprovalBroker = { requestApproval: vi.fn().mockResolvedValue(true) };
    const loop = new CoreLoop({
      ...makeDeps(),
      runtimeBudgetStore,
      waitApprovalBroker,
      reportingEngine: { generateExecutionSummary: vi.fn(), saveReport: vi.fn() },
    } as unknown as CoreLoopDeps, {
      maxIterations: 2,
      delayBetweenLoopsMs: 0,
      autoDecompose: false,
      runtimeBudget: {
        budgetId: "budget-stop-policy",
        limits: [{ dimension: "iterations", limit: 1, exhaustion_policy: "stop" }],
      },
    });
    const runOneIteration = vi.spyOn(loop, "runOneIteration").mockResolvedValue(
      makeEmptyIterationResult("goal-budget-stop", 0)
    );

    const result = await loop.run("goal-budget-stop");

    expect(result.totalIterations).toBe(0);
    expect(result.finalStatus).toBe("stopped");
    expect(runOneIteration).not.toHaveBeenCalled();
    expect(waitApprovalBroker.requestApproval).not.toHaveBeenCalled();
  });
});
