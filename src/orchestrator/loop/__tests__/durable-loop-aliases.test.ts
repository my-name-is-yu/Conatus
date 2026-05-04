import { describe, expect, it, vi } from "vitest";
import {
  CoreLoop,
  DurableLoop,
  type CoreLoopDeps,
  type DurableLoopDeps,
} from "../durable-loop.js";
import {
  createCoreLoopControlTools,
  createDaemonBackedCoreLoopControlToolset,
  createDaemonBackedDurableLoopControlToolset,
  createDurableLoopControlTools,
  type CoreLoopControlToolset,
  type DurableLoopControlToolset,
} from "../../execution/agent-loop/durable-loop-control-tools.js";

function makeDeps(): DurableLoopDeps {
  return {
    stateManager: {
      loadGoal: vi.fn(),
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
  } as unknown as DurableLoopDeps;
}

describe("DurableLoop compatibility aliases", () => {
  it("exports DurableLoop as the same constructor as the legacy CoreLoop name", () => {
    const durableLoopDeps: DurableLoopDeps = makeDeps();
    const legacyDeps: CoreLoopDeps = durableLoopDeps;

    const durableLoop = new DurableLoop(durableLoopDeps, { dryRun: true });
    const legacyLoop = new CoreLoop(legacyDeps, { dryRun: true });

    expect(DurableLoop).toBe(CoreLoop);
    expect(durableLoop).toBeInstanceOf(CoreLoop);
    expect(legacyLoop).toBeInstanceOf(DurableLoop);
  });

  it("keeps DurableLoop and legacy CoreLoop control factories behaviorally identical", () => {
    const service: DurableLoopControlToolset = {
      goalStatus: async (input) => ({ goalId: input.goalId, loopStatus: "idle" }),
      goalStart: async (input) => ({ goalId: input.goalId, started: true }),
    };
    const legacyService: CoreLoopControlToolset = service;

    const durableTools = createDurableLoopControlTools(service);
    const legacyTools = createCoreLoopControlTools(legacyService);

    expect(createCoreLoopControlTools).toBe(createDurableLoopControlTools);
    expect(durableTools.map((tool) => tool.metadata.name)).toEqual(
      legacyTools.map((tool) => tool.metadata.name),
    );
    expect(durableTools.map((tool) => tool.description())).toEqual(
      legacyTools.map((tool) => tool.description()),
    );
  });

  it("keeps daemon-backed DurableLoop and legacy CoreLoop toolset factories behaviorally identical", () => {
    const deps = {
      stateManager: {
        getBaseDir: () => "/tmp/pulseed-test",
        loadGoal: async (goalId: string) => ({
          id: goalId,
          title: "Goal",
          status: "active",
          loop_status: "idle",
          dimensions: [],
          updated_at: "now",
        }),
        saveGoal: vi.fn(),
        listTasks: async () => [],
        loadTask: async () => null,
      },
      daemonClientFactory: async () => ({
        startGoal: async () => ({ ok: true }),
        stopGoal: async () => ({ ok: true }),
        pauseGoal: async () => ({ ok: true }),
        resumeGoal: async () => ({ ok: true }),
        getSnapshot: async () => ({ active_workers: [] }),
      }),
    };

    const durableTools = createDurableLoopControlTools(
      createDaemonBackedDurableLoopControlToolset(deps as never),
    );
    const legacyTools = createCoreLoopControlTools(
      createDaemonBackedCoreLoopControlToolset(deps as never),
    );

    expect(createDaemonBackedCoreLoopControlToolset).toBe(createDaemonBackedDurableLoopControlToolset);
    expect(durableTools.map((tool) => tool.metadata.name)).toEqual(
      legacyTools.map((tool) => tool.metadata.name),
    );
  });
});
