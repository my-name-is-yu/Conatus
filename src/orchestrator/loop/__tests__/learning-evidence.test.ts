import { describe, it, expect, vi } from "vitest";
import { gatherLearningEvidence } from "../learning-evidence.js";
import type { ToolExecutor } from "../../../tools/executor.js";
import type { ToolCallContext } from "../../../tools/types.js";

const baseContext: ToolCallContext = {
  cwd: ".",
  goalId: "goal-1",
  trustBalance: 0,
  preApproved: true,
  approvalFn: async () => false,
};

function makeExecutor(
  overrides: Partial<Record<string, { success: boolean; data: unknown }>>
): ToolExecutor {
  return {
    execute: vi.fn(async (toolName: string) => {
      const result = overrides[toolName];
      if (!result) throw new Error(`Unexpected tool: ${toolName}`);
      return {
        success: result.success,
        data: result.data,
        summary: "",
        durationMs: 0,
      };
    }),
  } as unknown as ToolExecutor;
}

describe("gatherLearningEvidence", () => {
  it("populates recentChanges when git_diff returns content", async () => {
    const executor = makeExecutor({
      git_diff: { success: true, data: "diff --git a/foo.ts" },
      glob: { success: true, data: [] },
    });

    const result = await gatherLearningEvidence(executor, baseContext);

    expect(result.recentChanges).toBe("diff --git a/foo.ts");
    expect(result.errors).toHaveLength(0);
  });

  it("leaves recentChanges empty when git_diff returns empty string", async () => {
    const executor = makeExecutor({
      git_diff: { success: true, data: "" },
      glob: { success: true, data: [] },
    });

    const result = await gatherLearningEvidence(executor, baseContext);

    expect(result.recentChanges).toBe("");
  });

  it("leaves recentChanges empty when git_diff fails", async () => {
    const executor = makeExecutor({
      git_diff: { success: false, data: null },
      glob: { success: true, data: [] },
    });

    const result = await gatherLearningEvidence(executor, baseContext);

    expect(result.recentChanges).toBe("");
    expect(result.errors).toHaveLength(0);
  });

  it("counts artifacts when glob returns array of 5 entries", async () => {
    const executor = makeExecutor({
      git_diff: { success: true, data: "" },
      glob: { success: true, data: ["a", "b", "c", "d", "e"] },
    });

    const result = await gatherLearningEvidence(executor, baseContext);

    expect(result.artifactCount).toBe(5);
  });

  it("counts artifacts when glob returns newline-separated string", async () => {
    const executor = makeExecutor({
      git_diff: { success: true, data: "" },
      glob: { success: true, data: "a\nb\nc\n" },
    });

    const result = await gatherLearningEvidence(executor, baseContext);

    expect(result.artifactCount).toBe(3);
  });

  it("captures error and preserves defaults when git_diff throws", async () => {
    const executor = {
      execute: vi.fn(async (toolName: string) => {
        if (toolName === "git_diff") throw new Error("git not found");
        return { success: true, data: [], summary: "", durationMs: 0 };
      }),
    } as unknown as ToolExecutor;

    const result = await gatherLearningEvidence(executor, baseContext);

    expect(result.recentChanges).toBe("");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("git_diff");
    expect(result.errors[0]).toContain("git not found");
  });

  it("captures error and preserves defaults when glob throws", async () => {
    const executor = {
      execute: vi.fn(async (toolName: string) => {
        if (toolName === "glob") throw new Error("permission denied");
        return { success: true, data: "diff output", summary: "", durationMs: 0 };
      }),
    } as unknown as ToolExecutor;

    const result = await gatherLearningEvidence(executor, baseContext);

    expect(result.artifactCount).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("glob");
    expect(result.errors[0]).toContain("permission denied");
  });

  it("truncates recentChanges to 2000 chars", async () => {
    const longDiff = "x".repeat(5000);
    const executor = makeExecutor({
      git_diff: { success: true, data: longDiff },
      glob: { success: true, data: [] },
    });

    const result = await gatherLearningEvidence(executor, baseContext);

    expect(result.recentChanges).toHaveLength(2000);
    expect(result.recentChanges).toBe("x".repeat(2000));
  });

  it("passes workspacePath to git_diff", async () => {
    const executeFn = vi.fn(async () => ({
      success: true,
      data: "",
      summary: "",
      durationMs: 0,
    }));
    const executor = { execute: executeFn } as unknown as ToolExecutor;

    await gatherLearningEvidence(executor, baseContext, "/some/path");

    expect(executeFn).toHaveBeenCalledWith(
      "git_diff",
      expect.objectContaining({ path: "/some/path" }),
      baseContext,
    );
  });
});
