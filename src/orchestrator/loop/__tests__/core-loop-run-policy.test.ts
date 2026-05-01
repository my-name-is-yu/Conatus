import { describe, expect, it, vi } from "vitest";
import { CoreLoop, makeEmptyIterationResult, type CoreLoopDeps } from "../core-loop.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";

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
});
