/**
 * Integration tests for auto-infer flow in goal-dispatch.ts
 *
 * Tests that:
 * 1. When title provided, no dims → infers → prompts → calls cmdGoalAddRaw
 * 2. When --yes provided → auto-accepts without readline prompt
 * 3. When --dim provided → skips inference entirely
 * 4. When LLM inference returns empty → falls through to refine mode
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { CharacterConfigManager } from "../../../platform/traits/character-config.js";

// ─── Module-level mocks ───
// Note: vi.mock factories are hoisted — DO NOT reference outer variables inside them.

vi.mock("../commands/goal-raw.js", () => ({
  cmdGoalAddRaw: vi.fn().mockResolvedValue(0),
}));

vi.mock("../commands/goal.js", () => ({
  cmdGoalAdd: vi.fn().mockResolvedValue(0),
  cmdGoalList: vi.fn().mockResolvedValue(0),
  cmdGoalShow: vi.fn().mockResolvedValue(0),
  cmdGoalReset: vi.fn().mockResolvedValue(0),
  cmdGoalArchive: vi.fn().mockResolvedValue(0),
}));

vi.mock("../../../base/llm/provider-factory.js", () => ({
  buildLLMClient: vi.fn().mockResolvedValue({ sendMessage: vi.fn(), parseJSON: vi.fn() }),
}));

vi.mock("../commands/goal-infer.js", () => ({
  inferDimensionsFromTitle: vi.fn().mockResolvedValue([]),
  formatInferredDimensions: vi.fn().mockReturnValue("  1. fluency_score  [min]  threshold: 80"),
}));

vi.mock("../utils.js", () => ({
  promptYesNo: vi.fn().mockResolvedValue(false),
  formatOperationError: vi.fn().mockReturnValue("operation failed"),
}));

// ─── Imports after mocks ───

import { dispatchGoalCommand } from "../commands/goal-dispatch.js";
import * as goalRaw from "../commands/goal-raw.js";
import * as goal from "../commands/goal.js";
import * as providerFactory from "../../../base/llm/provider-factory.js";
import * as goalInfer from "../commands/goal-infer.js";
import * as cliUtils from "../utils.js";

// ─── Helpers ───

function makeStateManager(): StateManager {
  return {} as StateManager;
}

function makeCharacterConfigManager(): CharacterConfigManager {
  return {} as CharacterConfigManager;
}

// ─── Tests ───

describe("dispatchGoalCommand — auto-infer flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset defaults after clear
    vi.mocked(providerFactory.buildLLMClient).mockResolvedValue({ sendMessage: vi.fn(), parseJSON: vi.fn() });
    vi.mocked(goalRaw.cmdGoalAddRaw).mockResolvedValue(0);
    vi.mocked(goal.cmdGoalAdd).mockResolvedValue(0);
    vi.mocked(goalInfer.inferDimensionsFromTitle).mockResolvedValue([]);
    vi.mocked(goalInfer.formatInferredDimensions).mockReturnValue(
      "  1. fluency_score  [min]  threshold: 80"
    );
    vi.mocked(cliUtils.promptYesNo).mockResolvedValue(false);
  });

  it("calls cmdGoalAddRaw with inferred dims after user accepts", async () => {
    const deadline = "2026-06-01T00:00:00.000Z";
    vi.mocked(goalInfer.inferDimensionsFromTitle).mockResolvedValue([
      { name: "fluency_score", type: "min", value: "80" },
    ]);

    // Simulate user accepting the prompt
    vi.mocked(cliUtils.promptYesNo).mockResolvedValue(true);

    const result = await dispatchGoalCommand(
      "add",
      ["--title", "英語ペラペラになりたい", "--deadline", deadline],
      false,
      makeStateManager(),
      makeCharacterConfigManager()
    );

    expect(goalInfer.inferDimensionsFromTitle).toHaveBeenCalledOnce();
    expect(goalRaw.cmdGoalAddRaw).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: "英語ペラペラになりたい",
        rawDimensions: ["fluency_score:min:80"],
        deadline,
      })
    );
    expect(result).toBe(0);
  });

  it("auto-accepts with --yes flag and skips readline prompt", async () => {
    vi.mocked(goalInfer.inferDimensionsFromTitle).mockResolvedValue([
      { name: "vocab_count", type: "min", value: "3000" },
    ]);

    const result = await dispatchGoalCommand(
      "add",
      ["--title", "英語ペラペラになりたい", "--yes"],
      false,
      makeStateManager(),
      makeCharacterConfigManager()
    );

    expect(cliUtils.promptYesNo).not.toHaveBeenCalled();
    expect(goalRaw.cmdGoalAddRaw).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rawDimensions: ["vocab_count:min:3000"],
      })
    );
    expect(result).toBe(0);
  });

  it("auto-accepts when globalYes is true", async () => {
    vi.mocked(goalInfer.inferDimensionsFromTitle).mockResolvedValue([
      { name: "score", type: "max", value: "5" },
    ]);

    await dispatchGoalCommand(
      "add",
      ["--title", "keep errors low"],
      true, // globalYes
      makeStateManager(),
      makeCharacterConfigManager()
    );

    expect(cliUtils.promptYesNo).not.toHaveBeenCalled();
    expect(goalRaw.cmdGoalAddRaw).toHaveBeenCalledOnce();
  });

  it("skips inference when --dim is provided (existing raw mode)", async () => {
    const deadline = "2026-06-02T00:00:00.000Z";
    const result = await dispatchGoalCommand(
      "add",
      ["--title", "fix errors", "--dim", "error_count:min:0", "--deadline", deadline],
      false,
      makeStateManager(),
      makeCharacterConfigManager()
    );

    expect(goalInfer.inferDimensionsFromTitle).not.toHaveBeenCalled();
    expect(goalRaw.cmdGoalAddRaw).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rawDimensions: ["error_count:min:0"],
        deadline,
      })
    );
    expect(result).toBe(0);
  });

  it("passes --deadline through the non-raw refine path when inference is not accepted", async () => {
    const deadline = "2026-06-03T00:00:00.000Z";
    vi.mocked(goalInfer.inferDimensionsFromTitle).mockResolvedValue([]);

    const result = await dispatchGoalCommand(
      "add",
      ["keep docs current", "--deadline", deadline],
      false,
      makeStateManager(),
      makeCharacterConfigManager()
    );

    expect(goalRaw.cmdGoalAddRaw).not.toHaveBeenCalled();
    expect(goal.cmdGoalAdd).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "keep docs current",
      expect.objectContaining({ deadline })
    );
    expect(result).toBe(0);
  });

  it("falls through to refine mode when inference returns empty array", async () => {
    vi.mocked(goalInfer.inferDimensionsFromTitle).mockResolvedValue([]);

    // description positional triggers refine mode
    const result = await dispatchGoalCommand(
      "add",
      ["英語ペラペラになりたい"],
      false,
      makeStateManager(),
      makeCharacterConfigManager()
    );

    expect(goalInfer.inferDimensionsFromTitle).toHaveBeenCalledOnce();
    expect(goalRaw.cmdGoalAddRaw).not.toHaveBeenCalled();
    expect(goal.cmdGoalAdd).toHaveBeenCalledOnce();
    expect(result).toBe(0);
  });

  it("falls through to refine mode when user rejects inferred dims", async () => {
    vi.mocked(goalInfer.inferDimensionsFromTitle).mockResolvedValue([
      { name: "score", type: "min", value: "70" },
    ]);

    // Simulate user rejecting the prompt
    vi.mocked(cliUtils.promptYesNo).mockResolvedValue(false);

    const result = await dispatchGoalCommand(
      "add",
      ["英語ペラペラになりたい"],
      false,
      makeStateManager(),
      makeCharacterConfigManager()
    );

    expect(goalRaw.cmdGoalAddRaw).not.toHaveBeenCalled();
    expect(goal.cmdGoalAdd).toHaveBeenCalledOnce();
    expect(result).toBe(0);
  });

  it("skips inference when --no-refine is provided", async () => {
    vi.mocked(goalInfer.inferDimensionsFromTitle).mockResolvedValue([
      { name: "score", type: "min", value: "80" },
    ]);

    const result = await dispatchGoalCommand(
      "add",
      ["英語ペラペラになりたい", "--no-refine"],
      false,
      makeStateManager(),
      makeCharacterConfigManager()
    );

    expect(goalInfer.inferDimensionsFromTitle).not.toHaveBeenCalled();
    expect(goalRaw.cmdGoalAddRaw).not.toHaveBeenCalled();
    expect(goal.cmdGoalAdd).toHaveBeenCalledOnce();
    expect(result).toBe(0);
  });

  it("falls through to refine mode when LLM client is unavailable", async () => {
    vi.mocked(providerFactory.buildLLMClient).mockRejectedValue(
      new Error("no provider configured")
    );

    const result = await dispatchGoalCommand(
      "add",
      ["英語ペラペラになりたい"],
      false,
      makeStateManager(),
      makeCharacterConfigManager()
    );

    expect(goalInfer.inferDimensionsFromTitle).not.toHaveBeenCalled();
    expect(goal.cmdGoalAdd).toHaveBeenCalledOnce();
    expect(result).toBe(0);
  });
});
