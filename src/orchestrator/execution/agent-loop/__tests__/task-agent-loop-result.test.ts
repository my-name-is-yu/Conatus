import { describe, expect, it } from "vitest";
import { taskAgentLoopResultToAgentResult } from "../task-agent-loop-result.js";

describe("taskAgentLoopResultToAgentResult", () => {
  it("carries apply_patch artifacts as concrete changed paths", () => {
    const result = taskAgentLoopResultToAgentResult({
      success: true,
      output: {
        status: "done",
        finalAnswer: "done",
        summary: "done",
        filesChanged: [],
        testsRun: [],
        completionEvidence: [],
        verificationHints: [],
        blockers: [],
      },
      finalText: "done",
      stopReason: "completed",
      elapsedMs: 1,
      modelTurns: 1,
      toolCalls: 1,
      compactions: 0,
      changedFiles: [],
      toolResults: [{
        toolName: "apply_patch",
        success: true,
        artifacts: ["reports/result.md", "../outside.md", "/tmp/outside.md"],
        outputSummary: "Patch applied: reports/result.md",
        durationMs: 1,
      }],
      commandResults: [],
      traceId: "trace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    });

    expect(result.filesChanged).toBe(true);
    expect(result.filesChangedPaths).toEqual(["reports/result.md"]);
    expect(result.agentLoop?.filesChangedPaths).toEqual(["reports/result.md"]);
  });

  it("does not carry check-only apply_patch artifacts as changed paths", () => {
    const result = taskAgentLoopResultToAgentResult({
      success: true,
      output: {
        status: "done",
        finalAnswer: "done",
        summary: "done",
        filesChanged: [],
        testsRun: [],
        completionEvidence: [],
        verificationHints: [],
        blockers: [],
      },
      finalText: "done",
      stopReason: "completed",
      elapsedMs: 1,
      modelTurns: 1,
      toolCalls: 1,
      compactions: 0,
      changedFiles: [],
      toolResults: [{
        toolName: "apply_patch",
        success: true,
        artifacts: ["reports/check-only.md"],
        checkOnly: true,
        outputSummary: "Patch check passed: reports/check-only.md",
        durationMs: 1,
      }],
      commandResults: [],
      traceId: "trace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    });

    expect(result.filesChanged).toBe(false);
    expect(result.filesChangedPaths).toEqual([]);
    expect(result.agentLoop?.filesChangedPaths).toEqual([]);
  });
});
