import { describe, it, expect, vi } from "vitest";
import { ContextAssembler } from "../../src/prompt/context-assembler.js";
import type { ContextAssemblerDeps } from "../../src/prompt/context-assembler.js";

const makeGoalState = (overrides: Record<string, any> = {}) => ({
  id: "goal-1",
  title: "Increase test coverage",
  description: "Get to 90% coverage",
  dimensions: [
    {
      name: "coverage",
      current_value: 75,
      threshold: { value: 90 },
      gap: 15,
      history: [
        { timestamp: "2026-01-01", value: 70 },
        { timestamp: "2026-01-02", value: 75 },
      ],
    },
  ],
  active_strategy: { hypothesis: "Add unit tests for uncovered files" },
  ...overrides,
});

describe("ContextAssembler", () => {
  describe("build() with no deps", () => {
    it("returns empty context block when no dependencies are injected", async () => {
      const assembler = new ContextAssembler({});
      const result = await assembler.build("observation", "goal-1");
      expect(result.contextBlock).toBe("");
      expect(result.totalTokensUsed).toBe(0);
    });

    it("returns empty systemPrompt (gateway uses PURPOSE_CONFIGS instead)", async () => {
      const assembler = new ContextAssembler({});
      const result = await assembler.build("observation", "goal-1");
      expect(result.systemPrompt).toBe("");
    });
  });

  describe("build() with stateManager", () => {
    it("includes goal_context when stateManager resolves goal state", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("observation", "goal-1");
      expect(result.contextBlock).toContain("goal_definition");
      expect(result.contextBlock).toContain("Increase test coverage");
    });

    it("includes current_state block with dimension data", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("observation", "goal-1");
      expect(result.contextBlock).toContain("current_state");
      expect(result.contextBlock).toContain("coverage");
      expect(result.contextBlock).toContain("75");
    });

    it("handles stateManager returning null gracefully", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(null),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("observation", "goal-1");
      expect(result.contextBlock).toBe("");
    });
  });

  describe("build() for observation purpose", () => {
    it("includes dimension_history when goal has history", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("observation", "goal-1");
      expect(result.contextBlock).toContain("dimension_history");
    });

    it("includes workspace_state when contextProvider is available", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        contextProvider: {
          buildWorkspaceContextItems: vi.fn().mockResolvedValue([
            { label: "file", content: "src/index.ts" },
          ]),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("observation", "goal-1");
      expect(result.contextBlock).toContain("workspace_state");
      expect(result.contextBlock).toContain("src/index.ts");
    });

    it("does not include lessons slot for observation", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        memoryLifecycle: {
          selectForWorkingMemory: vi.fn().mockResolvedValue({
            shortTerm: [],
            lessons: [{ lesson: "Important lesson", relevance_tags: ["HIGH"] }],
          }),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("observation", "goal-1");
      // observation slot matrix does not include 'lessons'
      expect(result.contextBlock).not.toContain("<lessons>");
    });
  });

  describe("build() for task_generation purpose", () => {
    it("includes reflections when reflectionGetter returns data", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        reflectionGetter: vi.fn().mockResolvedValue([
          {
            why_it_worked_or_failed: "Wrong approach",
            what_to_do_differently: "Use mocks",
            what_was_attempted: "Direct integration",
          },
        ]),
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("task_generation", "goal-1");
      expect(result.contextBlock).toContain("reflections");
      expect(result.contextBlock).toContain("Wrong approach");
    });

    it("includes lessons when memoryLifecycle returns lessons", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        memoryLifecycle: {
          selectForWorkingMemory: vi.fn().mockResolvedValue({
            shortTerm: [],
            lessons: [{ lesson: "Use vi.fn()", relevance_tags: ["HIGH"] }],
          }),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("task_generation", "goal-1");
      expect(result.contextBlock).toContain("lessons");
      expect(result.contextBlock).toContain("Use vi.fn()");
    });

    it("includes knowledge when knowledgeManager returns entries", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        knowledgeManager: {
          getRelevantKnowledge: vi.fn().mockResolvedValue([
            { question: "How?", answer: "Like this." },
          ]),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("task_generation", "goal-1");
      expect(result.contextBlock).toContain("knowledge");
      expect(result.contextBlock).toContain("How?");
    });

    it("includes failure_context from additionalContext", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("task_generation", "goal-1", undefined, {
        failureContext: "Previous attempt timed out",
      });
      expect(result.contextBlock).toContain("failure_context");
      expect(result.contextBlock).toContain("Previous attempt timed out");
    });
  });

  describe("budget trimming", () => {
    it("does not exceed token budget when budget is tight", async () => {
      const goalState = makeGoalState({
        description: "x".repeat(500),
      });
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(goalState),
        },
        budgetTokens: 50,
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("observation", "goal-1");
      // totalTokensUsed should be at or near the budget
      expect(result.totalTokensUsed).toBeLessThanOrEqual(60);
    });

    it("returns all slots when budget is large enough", async () => {
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
        budgetTokens: 10000,
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("observation", "goal-1");
      expect(result.contextBlock).toContain("goal_definition");
      expect(result.contextBlock).toContain("current_state");
    });
  });

  describe("additionalContext usage", () => {
    it("uses existingTasks from additionalContext for recent_task_results", async () => {
      const tasks = [
        { task_description: "Write test", outcome: "passed", success: true },
      ];
      const deps: ContextAssemblerDeps = {
        stateManager: {
          loadGoalState: vi.fn().mockResolvedValue(makeGoalState()),
        },
      };
      const assembler = new ContextAssembler(deps);
      const result = await assembler.build("task_generation", "goal-1", undefined, {
        existingTasks: JSON.stringify(tasks),
      });
      expect(result.contextBlock).toContain("recent_task_results");
      expect(result.contextBlock).toContain("Write test");
    });
  });
});
