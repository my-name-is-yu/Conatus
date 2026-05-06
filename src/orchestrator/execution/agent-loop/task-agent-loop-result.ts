import { z } from "zod";
import * as path from "node:path";
import type { AgentResult } from "../adapter-layer.js";
import type { AgentLoopResult } from "./agent-loop-result.js";

export const TaskAgentLoopOutputSchema = z.object({
  status: z.enum(["done", "blocked", "partial", "failed"]),
  finalAnswer: z.string(),
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  testsRun: z.array(z.object({
    command: z.string(),
    passed: z.boolean(),
    outputSummary: z.string(),
  })).default([]),
  completionEvidence: z.array(z.string()).default([]),
  verificationHints: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
});

export type TaskAgentLoopOutput = z.infer<typeof TaskAgentLoopOutputSchema>;

function isSafeRelativeArtifact(filePath: string): boolean {
  const trimmed = filePath.trim();
  if (!trimmed || trimmed.includes("\0") || path.isAbsolute(trimmed)) return false;
  const segments = trimmed.replace(/\\/g, "/").split("/");
  return !segments.includes("..");
}

function collectAgentLoopChangedPaths(
  result: AgentLoopResult<TaskAgentLoopOutput>,
): string[] {
  const applyPatchArtifactPaths = (result.toolResults ?? []).flatMap((entry) => {
    if (!entry.success || entry.toolName !== "apply_patch" || entry.checkOnly === true) return [];
    return (entry.artifacts ?? []).map((artifact) => artifact.trim()).filter(isSafeRelativeArtifact);
  });
  return [
    ...new Set([
      ...(result.output?.filesChanged ?? []),
      ...result.changedFiles,
      ...applyPatchArtifactPaths,
    ]),
  ];
}

export function taskAgentLoopResultToAgentResult(
  result: AgentLoopResult<TaskAgentLoopOutput>,
): AgentResult {
  const done = result.success && result.output?.status === "done";
  const runtimeVerificationCommands = result.commandResults.filter((command) =>
    command.evidenceEligible && command.relevantToTask !== false
  );
  const filesChangedPaths = collectAgentLoopChangedPaths(result);
  const fallbackOutput = result.output?.finalAnswer
    ?? result.finalText
    ?? result.output?.blockers.join("; ")
    ?? result.stopReason;
  return {
    success: done,
    output: fallbackOutput,
    error: done ? null : result.output?.blockers.join("; ") || result.finalText || result.stopReason,
    exit_code: null,
    elapsed_ms: result.elapsedMs,
    stopped_reason:
      result.stopReason === "timeout" ? "timeout" :
      result.stopReason === "cancelled" ? "cancelled" :
      done ? "completed" : "error",
    filesChanged: filesChangedPaths.length > 0 || Boolean(result.filesChanged),
    filesChangedPaths,
    agentLoop: {
      traceId: result.traceId,
      sessionId: result.sessionId,
      turnId: result.turnId,
      stopReason: result.stopReason,
      modelTurns: result.modelTurns,
      toolCalls: result.toolCalls,
      usage: result.usage,
      compactions: result.compactions,
      ...(result.profileName ? { profileName: result.profileName } : {}),
      ...(result.reasoningEffort ? { reasoningEffort: result.reasoningEffort } : {}),
      completionEvidence: [
        ...(result.output?.completionEvidence ?? []),
        ...runtimeVerificationCommands.filter((command) => command.success).map((command) => `verified command: ${command.command}`),
      ],
      verificationHints: [
        ...(result.output?.verificationHints ?? []),
        ...runtimeVerificationCommands.filter((command) => !command.success).map((command) => `failed command: ${command.command}`),
      ],
      filesChangedPaths,
      ...(result.workspace
        ? {
            requestedCwd: result.workspace.requestedCwd,
            executionCwd: result.workspace.executionCwd,
            isolatedWorkspace: result.workspace.isolated,
            workspaceCleanupStatus: result.workspace.cleanupStatus,
            workspaceCleanupReason: result.workspace.cleanupReason,
          }
        : {}),
      ...(result.executionPolicy
        ? {
            sandboxMode: result.executionPolicy.sandboxMode,
            approvalPolicy: result.executionPolicy.approvalPolicy,
            networkAccess: result.executionPolicy.networkAccess,
          }
        : {}),
    },
  };
}
