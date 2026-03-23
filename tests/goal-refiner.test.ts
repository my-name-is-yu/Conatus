import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoalRefiner } from "../src/goal/goal-refiner.js";
import type { StateManager } from "../src/state-manager.js";
import type { ObservationEngine } from "../src/observation/observation-engine.js";
import type { GoalNegotiator } from "../src/goal/goal-negotiator.js";
import type { GoalTreeManager } from "../src/goal/goal-tree-manager.js";
import type { EthicsGate } from "../src/traits/ethics-gate.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeGoal, makeDimension } from "./helpers/fixtures.js";
import { randomUUID } from "node:crypto";

// ─── Fixtures ───

const measurableLeafTestResponse = JSON.stringify({
  is_measurable: true,
  dimensions: [
    {
      name: "test_coverage",
      label: "Test Coverage %",
      threshold_type: "min",
      threshold_value: 80,
      data_source: "shell",
      observation_command: "npm test -- --coverage | grep Statements",
    },
  ],
  reason: "Coverage is directly measurable with a shell command",
});

const notMeasurableLeafTestResponse = JSON.stringify({
  is_measurable: false,
  dimensions: null,
  reason: "Goal is too abstract to measure directly",
});

const feasibilityResponse = JSON.stringify({
  assessment: "realistic",
  confidence: "high",
  reasoning: "Target is achievable",
  key_assumptions: ["Tests exist"],
  main_risks: [],
});

// ─── Mock factories ───

function makeStateManager(goals: Record<string, ReturnType<typeof makeGoal>> = {}): StateManager {
  const store = { ...goals };
  return {
    loadGoal: vi.fn(async (id: string) => store[id] ?? null),
    saveGoal: vi.fn(async (goal: ReturnType<typeof makeGoal>) => {
      store[goal.id] = goal;
    }),
  } as unknown as StateManager;
}

function makeObservationEngine(): ObservationEngine {
  return {
    getDataSources: vi.fn(() => [
      { sourceId: "shell", config: { name: "shell" } },
    ]),
  } as unknown as ObservationEngine;
}

function makeNegotiator(): GoalNegotiator {
  return {} as unknown as GoalNegotiator;
}

function makeTreeManager(childGoals: ReturnType<typeof makeGoal>[] = []): GoalTreeManager {
  return {
    decomposeGoal: vi.fn(async (_goalId: string, _config: unknown) => {
      return {
        parent_id: _goalId,
        children: childGoals,
        depth: 1,
        specificity_scores: {},
        reasoning: "Decomposed into sub-goals",
      };
    }),
  } as unknown as GoalTreeManager;
}

function makeEthicsGate(): EthicsGate {
  return {} as unknown as EthicsGate;
}

// ─── Test suite ───

describe("GoalRefiner", () => {
  let goalId: string;
  let goal: ReturnType<typeof makeGoal>;

  beforeEach(() => {
    goalId = randomUUID();
    goal = makeGoal({
      id: goalId,
      description: "Achieve 80% test coverage",
      dimensions: [],
      origin: null,
      user_override: false,
    });
  });

  // ── Test 1: measurable goal → leaf with dimensions ──

  it("returns leaf RefineResult with dimensions when goal is measurable", async () => {
    const llmClient = createMockLLMClient([measurableLeafTestResponse, feasibilityResponse]);
    const stateManager = makeStateManager({ [goalId]: goal });
    const refiner = new GoalRefiner(
      stateManager,
      llmClient,
      makeObservationEngine(),
      makeNegotiator(),
      makeTreeManager(),
      makeEthicsGate()
    );

    const result = await refiner.refine(goalId);

    expect(result.leaf).toBe(true);
    expect(result.goal.node_type).toBe("leaf");
    expect(result.goal.dimensions).toHaveLength(1);
    expect(result.goal.dimensions[0]!.name).toBe("test_coverage");
    expect(result.goal.dimensions[0]!.threshold).toEqual({ type: "min", value: 80 });
    expect(result.goal.dimensions[0]!.observation_method.type).toBe("mechanical");
    expect(result.children).toBeNull();
    expect(result.feasibility).not.toBeNull();
    expect(result.feasibility).toHaveLength(1);
  });

  // ── Test 2: non-measurable goal → decomposes and recursively refines ──

  it("decomposes and recursively refines when goal is not measurable", async () => {
    const childId = randomUUID();
    const childGoal = makeGoal({
      id: childId,
      description: "Set up CI pipeline",
      parent_id: goalId,
      dimensions: [],
      origin: null,
      user_override: false,
      decomposition_depth: 1,
    });

    // For the root: not measurable
    // For the child: measurable
    const llmClient = createMockLLMClient([
      notMeasurableLeafTestResponse,
      measurableLeafTestResponse,
      feasibilityResponse,
    ]);

    const parentGoalWithChild = makeGoal({
      ...goal,
      children_ids: [childId],
    });

    const stateManager = makeStateManager({
      [goalId]: goal,
      [childId]: childGoal,
    });

    // Override loadGoal to return updated parent after decompose saves it
    const loadGoalMock = vi.fn(async (id: string) => {
      if (id === goalId) {
        // Return parent with children after first call
        return loadGoalMock.mock.calls.length > 1 ? parentGoalWithChild : goal;
      }
      return childGoal;
    });
    (stateManager as unknown as { loadGoal: typeof loadGoalMock }).loadGoal = loadGoalMock;

    const treeManager = makeTreeManager([childGoal]);
    // After decomposeGoal, update parent's children_ids in stateManager
    (treeManager.decomposeGoal as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_goalId: string) => {
        const updated = { ...goal, children_ids: [childId] };
        await stateManager.saveGoal(updated as ReturnType<typeof makeGoal>);
        return {
          parent_id: _goalId,
          children: [childGoal],
          depth: 1,
          specificity_scores: {},
          reasoning: "Decomposed",
        };
      }
    );

    const refiner = new GoalRefiner(
      stateManager,
      llmClient,
      makeObservationEngine(),
      makeNegotiator(),
      treeManager,
      makeEthicsGate()
    );

    const result = await refiner.refine(goalId);

    expect(result.leaf).toBe(false);
    expect(result.children).toHaveLength(1);
    expect(result.children![0]!.leaf).toBe(true);
    expect(result.children![0]!.goal.dimensions[0]!.name).toBe("test_coverage");
  });

  // ── Test 3: maxDepth reached → forces leaf for children at depth limit ──

  it("forces leaf when recursion depth >= maxDepth", async () => {
    const childId = randomUUID();
    const childGoal = makeGoal({
      id: childId,
      description: "Child goal",
      parent_id: goalId,
      origin: null,
      user_override: false,
      decomposition_depth: 1,
    });

    // Root (depth=0): not measurable → decomposes
    // Child (depth=1): depth >= maxDepth(1) → force leaf, no LLM call for child
    const llmClient = createMockLLMClient([notMeasurableLeafTestResponse]);

    const stateManager = makeStateManager({ [goalId]: goal, [childId]: childGoal });

    const treeManager = makeTreeManager([childGoal]);
    (treeManager.decomposeGoal as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_goalId: string) => {
        const updated = { ...goal, children_ids: [childId] };
        await stateManager.saveGoal(updated as ReturnType<typeof makeGoal>);
        return {
          parent_id: _goalId,
          children: [childGoal],
          depth: 1,
          specificity_scores: {},
          reasoning: "Decomposed",
        };
      }
    );

    const refiner = new GoalRefiner(
      stateManager,
      llmClient,
      makeObservationEngine(),
      makeNegotiator(),
      treeManager,
      makeEthicsGate()
    );

    // maxDepth: 1 → children at depth 1 are forced leaves
    const result = await refiner.refine(goalId, { maxDepth: 1 });

    expect(result.leaf).toBe(false); // root is not a leaf
    expect(result.children).toHaveLength(1);
    expect(result.children![0]!.leaf).toBe(true);
    expect(result.children![0]!.reason).toContain("max depth");
    expect(result.children![0]!.feasibility).toBeNull();
    // Only 1 LLM call (for root leaf test); child forced leaf without LLM call
    expect(llmClient.callCount).toBe(1);
  });

  // ── Test 4: tokenBudget exhausted → forces leaf ──

  it("forces leaf when tokenBudget is exhausted", async () => {
    const childId = randomUUID();
    const childGoal = makeGoal({
      id: childId,
      description: "Child goal",
      parent_id: goalId,
      origin: null,
      user_override: false,
      dimensions: [], // no validated dimensions — would need LLM call if budget allowed
      decomposition_depth: 1,
    });

    // Root call uses notMeasurable → decomposes. After decomposition, child call
    // encounters budget exceeded because root LLM call consumed ~1010 tokens
    // and tokenBudget is set to 1 (below ~1010).
    // But actually the budget check fires BEFORE the LLM call on each iteration.
    // The root call's LLM response costs 1010 tokens.
    // On the child call, shared.tokensUsed=1010 >= tokenBudget=500 → force leaf.
    const llmClient = createMockLLMClient([notMeasurableLeafTestResponse]);

    const stateManager = makeStateManager({ [goalId]: goal, [childId]: childGoal });

    const treeManager = makeTreeManager([childGoal]);
    (treeManager.decomposeGoal as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_goalId: string) => {
        const updated = { ...goal, children_ids: [childId] };
        await stateManager.saveGoal(updated as ReturnType<typeof makeGoal>);
        return {
          parent_id: _goalId,
          children: [childGoal],
          depth: 1,
          specificity_scores: {},
          reasoning: "Decomposed",
        };
      }
    );

    const refiner = new GoalRefiner(
      stateManager,
      llmClient,
      makeObservationEngine(),
      makeNegotiator(),
      treeManager,
      makeEthicsGate()
    );

    // tokenBudget=50: root call costs ~83 tokens (10 input + ~73 output)
    // child call sees tokensUsed (~83) >= tokenBudget (50) → force leaf
    const result = await refiner.refine(goalId, { tokenBudget: 50 });

    expect(result.leaf).toBe(false); // root is non-measurable → decomposed
    expect(result.children).toHaveLength(1);
    expect(result.children![0]!.leaf).toBe(true);
    expect(result.children![0]!.reason).toContain("token budget");
  });

  // ── Test 5: already-validated dimensions → skips refinement ──

  it("skips refinement when goal already has validated dimensions", async () => {
    const validatedGoal = makeGoal({
      ...goal,
      user_override: true,
      dimensions: [
        makeDimension({
          name: "coverage",
          observation_method: {
            type: "mechanical",
            source: "shell",
            schedule: null,
            endpoint: "npm test",
            confidence_tier: "mechanical",
          },
        }),
      ],
    });
    const stateManager = makeStateManager({ [goalId]: validatedGoal });
    const llmClient = createMockLLMClient([]); // no LLM calls expected

    const refiner = new GoalRefiner(
      stateManager,
      llmClient,
      makeObservationEngine(),
      makeNegotiator(),
      makeTreeManager(),
      makeEthicsGate()
    );

    const result = await refiner.refine(goalId);

    expect(result.leaf).toBe(true);
    expect(result.reason).toBe("already has validated dimensions");
    expect(llmClient.callCount).toBe(0);
  });

  // ── Test 6: LLM parse failure → handled gracefully ──

  it("handles LLM parse failure gracefully (treats as non-measurable)", async () => {
    const childId = randomUUID();
    const childGoal = makeGoal({
      id: childId,
      description: "Sub-goal",
      parent_id: goalId,
      origin: null,
      user_override: true, // skip further refinement
      dimensions: [makeDimension()],
    });

    // First response is invalid JSON
    const llmClient = createMockLLMClient(["this is not json at all"]);

    const stateManager = makeStateManager({ [goalId]: goal, [childId]: childGoal });

    const treeManager = makeTreeManager([childGoal]);
    (treeManager.decomposeGoal as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_goalId: string) => {
        const updated = { ...goal, children_ids: [childId] };
        await stateManager.saveGoal(updated as ReturnType<typeof makeGoal>);
        return {
          parent_id: _goalId,
          children: [childGoal],
          depth: 1,
          specificity_scores: {},
          reasoning: "Decomposed after parse failure",
        };
      }
    );

    const refiner = new GoalRefiner(
      stateManager,
      llmClient,
      makeObservationEngine(),
      makeNegotiator(),
      treeManager,
      makeEthicsGate()
    );

    // Should not throw
    const result = await refiner.refine(goalId);

    // Parse failure treated as non-measurable → decompose path
    expect(result.leaf).toBe(false);
    expect(result.children).toHaveLength(1);
  });

  // ── Test 7: reRefineLeaf includes failure context ──

  it("reRefineLeaf includes failure context in prompt", async () => {
    const llmClient = createMockLLMClient([measurableLeafTestResponse, feasibilityResponse]);
    const stateManager = makeStateManager({ [goalId]: goal });

    let capturedLeafTestPrompt = "";
    let firstCall = true;
    const origSendMessage = llmClient.sendMessage.bind(llmClient);
    llmClient.sendMessage = vi.fn(async (messages, opts) => {
      if (firstCall && messages[0]) {
        capturedLeafTestPrompt = messages[0].content as string;
        firstCall = false;
      }
      return origSendMessage(messages, opts);
    });

    const refiner = new GoalRefiner(
      stateManager,
      llmClient,
      makeObservationEngine(),
      makeNegotiator(),
      makeTreeManager(),
      makeEthicsGate()
    );

    await refiner.reRefineLeaf(goalId, "observation command not found");

    expect(capturedLeafTestPrompt).toContain("observation command not found");
  });
});
