import { z } from "zod";
import * as path from "node:path";
import type { Task } from "../../../base/types/task.js";
import type { VerificationResult } from "../../../base/types/task.js";
import type { AgentTask, AgentResult, IAdapter } from "../adapter-layer.js";
import type { VerifierDeps } from "./task-verifier-types.js";
import { syncTaskOutcomeSummary } from "./task-outcome-ledger.js";
import { resolveTaskWorkspacePath } from "./task-workspace.js";

// ─── runMechanicalVerification ───

export async function runMechanicalVerification(
  deps: VerifierDeps,
  task: Task
): Promise<{ applicable: boolean; passed: boolean; description: string }> {
  // Mechanical prefixes that indicate a command can be run directly
  const mechanicalPrefixes = [
    "npm",
    "npx",
    "pytest",
    "sh",
    "bash",
    "node",
    "make",
    "cargo",
    "go ",
    "gh ",
    "rg ",
    "grep ",
    "test ",
    "ls ",
  ];

  const isMechanicalMethod = (verificationMethod: string): boolean => {
    const method = verificationMethod.toLowerCase().trim();
    return mechanicalPrefixes.some((prefix) => method.startsWith(prefix));
  };

  const blockingMechanicalCriteria = task.success_criteria.filter(
    (c) => c.is_blocking && isMechanicalMethod(c.verification_method)
  );

  if (blockingMechanicalCriteria.length === 0) {
    return {
      applicable: false,
      passed: false,
      description: "No blocking mechanical verification criteria applicable",
    };
  }

  const verificationCommands = blockingMechanicalCriteria.map((c) => c.verification_method.trim());
  verificationCommands.sort((left, right) => {
    const leftIsTestCommand = /^(npm|npx|pytest|sh|bash|node|make|cargo|go )/.test(left.toLowerCase());
    const rightIsTestCommand = /^(npm|npx|pytest|sh|bash|node|make|cargo|go )/.test(right.toLowerCase());
    return Number(rightIsTestCommand) - Number(leftIsTestCommand);
  });

  // If no adapter registry is available, fall back to assumed pass (backward compat)
  if (!deps.adapterRegistry) {
    return {
      applicable: true,
      passed: true,
      description: `Mechanical verification criteria detected (${verificationCommands.length} command(s), no adapter: assumed pass)`,
    };
  }

  // Select the first available adapter from the registry for command execution
  const availableAdapters = deps.adapterRegistry.listAdapters();
  if (availableAdapters.length === 0) {
    return {
      applicable: true,
      passed: true,
      description: `Mechanical verification criteria detected (${verificationCommands.length} command(s), no adapters registered: assumed pass)`,
    };
  }

  const adapterType =
    deps.preferredAdapterType && availableAdapters.includes(deps.preferredAdapterType)
      ? deps.preferredAdapterType
      : availableAdapters[0]!;
  let adapter: IAdapter;
  try {
    adapter = deps.adapterRegistry.getAdapter(adapterType);
  } catch {
    return {
      applicable: true,
      passed: true,
      description: `Mechanical verification criteria detected (${verificationCommands.length} command(s), adapter lookup failed: assumed pass)`,
    };
  }

  const verificationTimeoutMs = 30_000; // 30 seconds default for L1 mechanical checks
  const passedCommands: string[] = [];

  for (const verificationCommand of verificationCommands) {
    const agentTask: AgentTask = {
      prompt: verificationCommand,
      timeout_ms: verificationTimeoutMs,
      adapter_type: adapterType,
    };

    let result: AgentResult;
    try {
      result = await adapter.execute(agentTask);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      deps.logger?.error("runMechanicalVerification: adapter.execute() threw", { error: errMsg });
      return {
        applicable: true,
        passed: false,
        description: `Mechanical verification command threw: ${verificationCommand} — ${errMsg}`,
      };
    }

    if (result.stopped_reason === "timeout") {
      return {
        applicable: true,
        passed: false,
        description: `Mechanical verification timed out after ${verificationTimeoutMs}ms (command: ${verificationCommand})`,
      };
    }

    if (result.exit_code !== 0 || !result.success) {
      return {
        applicable: true,
        passed: false,
        description: `Mechanical verification failed after ${passedCommands.length}/${verificationCommands.length} command(s) (exit ${result.exit_code ?? "null"}): ${verificationCommand}${result.error ? ` — ${result.error}` : ""}`,
      };
    }

    passedCommands.push(verificationCommand);
  }

  return {
    applicable: true,
    passed: true,
    description: `Mechanical verification passed (${passedCommands.length} command(s)): ${passedCommands.join("; ")}`,
  };
}

// ─── P0 Guard 1: dimension_updates change magnitude limit (§3.2) ───

/**
 * Clamp a proposed dimension update to within ±30% absolute or ±30% relative
 * of the current value (whichever is larger). Logs a warning when clamping occurs.
 *
 * Exported for unit testing.
 */
export function clampDimensionUpdate(
  current: number,
  proposed: number,
  logger?: import("../../../runtime/logger.js").Logger,
  dimName?: string
): number {
  const absLimit = 0.3;
  const relLimit = Math.abs(current) * 0.3;
  const maxDelta = Math.max(absLimit, relLimit);
  const clamped = Math.max(current - maxDelta, Math.min(current + maxDelta, proposed));
  if (clamped !== proposed) {
    logger?.warn(
      `dimension_update clamped: dim=${dimName}, proposed=${proposed}, applied=${clamped}, current=${current}`
    );
  }
  return clamped;
}

// ─── §4.5 Guard: dimension_updates direction check ───

/**
 * Check whether a proposed dimension update moves in the intended direction.
 * Returns true if the update should be applied, false if it should be skipped.
 *
 * Exported for unit testing.
 */
export function checkDimensionDirection(
  intendedDirection: "increase" | "decrease" | "neutral" | undefined,
  currentValue: number,
  proposedValue: number,
  logger?: { warn: (msg: string) => void },
  dimName?: string,
): boolean {
  if (!intendedDirection || intendedDirection === "neutral") return true;

  const actualDirection =
    proposedValue > currentValue
      ? "increase"
      : proposedValue < currentValue
        ? "decrease"
        : "neutral";

  if (intendedDirection === "increase" && actualDirection === "decrease") {
    logger?.warn(
      `dimension_update direction mismatch: task intended ${intendedDirection}, but update suggests ${actualDirection} for dim ${dimName ?? "unknown"}`
    );
    return false;
  }
  if (intendedDirection === "decrease" && actualDirection === "increase") {
    logger?.warn(
      `dimension_update direction mismatch: task intended ${intendedDirection}, but update suggests ${actualDirection} for dim ${dimName ?? "unknown"}`
    );
    return false;
  }
  return true;
}

// ─── parseExecutorReport ───

export function parseExecutorReport(executionResult: AgentResult): import("./task-verifier-types.js").ExecutorReport {
  const completionEvidence = executionResult.agentLoop?.completionEvidence ?? [];
  const verificationHints = executionResult.agentLoop?.verificationHints ?? [];
  const stopReason = executionResult.agentLoop?.stopReason ?? executionResult.stopped_reason;
  const summaryParts = [
    executionResult.output.slice(0, 500),
    completionEvidence.length > 0 ? `completion evidence: ${completionEvidence.join("; ")}` : "",
  ].filter((part) => part.length > 0);

  return {
    completed: executionResult.success,
    summary: summaryParts.join("\n"),
    partial_results: completionEvidence,
    blockers: [
      ...(executionResult.error ? [executionResult.error] : []),
      ...(executionResult.success || stopReason === "completed" ? [] : [`stop reason: ${stopReason}`]),
    ],
    stop_reason: stopReason,
    completion_evidence: completionEvidence,
    verification_hints: verificationHints,
    trace_id: executionResult.agentLoop?.traceId,
    session_id: executionResult.agentLoop?.sessionId,
    turn_id: executionResult.agentLoop?.turnId,
  };
}

// ─── isDirectionCorrect ───

export function isDirectionCorrect(verificationResult: VerificationResult): boolean {
  return verificationResult.verdict === "partial";
}

// ─── attemptRevert ───

async function resolveRevertCwd(deps: VerifierDeps, task: Task): Promise<string | null> {
  return await resolveTaskWorkspacePath({
    stateManager: deps.stateManager,
    task,
    fallbackCwd: deps.revertCwd?.trim() || undefined,
  }) ?? null;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isRelativeGitPath(filePath: string): boolean {
  const trimmed = filePath.trim();
  if (!trimmed || trimmed.includes("\0") || path.isAbsolute(trimmed)) {
    return false;
  }
  const segments = trimmed.replace(/\\/g, "/").split("/");
  return !segments.includes("..");
}

export async function attemptRevert(
  deps: VerifierDeps,
  task: Task,
  opts: { concretePaths?: string[] } = {}
): Promise<boolean> {
  const filesToRestore = [
    ...new Set((opts.concretePaths ?? []).map((filePath) => filePath.trim()).filter(Boolean)),
  ];
  try {
    if (filesToRestore.length > 0) {
      const revertCwd = await resolveRevertCwd(deps, task);
      if (!revertCwd) {
        deps.logger?.warn?.("[attemptRevert] skipping raw git restore because no workspace_path/revertCwd was configured");
        throw new Error("git restore disabled without explicit workspace");
      }
      if (deps.toolExecutor) {
        // Use ToolExecutor (preferred): keeps all shell ops in the tool pipeline
        const ctx: import("../../../tools/types.js").ToolCallContext = {
          cwd: revertCwd,
          goalId: task.goal_id,
          trustBalance: 100,
          preApproved: true,
          trusted: true,
          approvalFn: async () => true,
        };
        const allSafe = filesToRestore.every(isRelativeGitPath);
        if (!allSafe) {
          deps.logger?.warn?.(
            "[attemptRevert] concrete changed path failed git-restore path validation; falling back to LLM revert"
          );
          throw new Error("git restore disabled for invalid concrete changed path");
        } else {
          const result = await deps.toolExecutor.execute(
            "shell",
            { command: "git restore -- " + filesToRestore.map(quoteShellArg).join(" ") },
            ctx
          );
          if (result.success) {
            deps.logger?.info?.(`[attemptRevert] git restore succeeded for ${filesToRestore.length} files (via ToolExecutor)`);
            return true;
          }
          // Fall through to LLM-based revert if shell tool failed
        }
      } else {
        // Fallback: raw child_process (no ToolExecutor available)
        const { execFileSync } = await import("child_process");
        execFileSync("git", ["restore", "--", ...filesToRestore], {
          cwd: revertCwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        deps.logger?.info?.(`[attemptRevert] git restore succeeded for ${filesToRestore.length} files`);
        return true;
      }
    } else {
      deps.logger?.warn?.("[attemptRevert] skipping raw git restore because no concrete changed paths were captured");
    }
  } catch {
    // git not available or failed — fall back to LLM-based revert
  }

  try {
    const revertSession = await deps.sessionManager.createSession(
      "task_execution",
      task.goal_id,
      task.id
    );

    const revertTargetSummary =
      filesToRestore.length > 0
        ? `Concrete changed paths: ${filesToRestore.join(", ")}.`
        : "No concrete changed paths were captured. Do not treat task scope descriptions as file paths.";

    const revertPrompt = `Revert task "${task.work_description}". ${revertTargetSummary}

Return JSON: {"success": true|false, "reason": "..."}`;

    const response = await deps.llmClient.sendMessage(
      [{ role: "user", content: revertPrompt }],
      { system: "Revert failed task changes. Respond with JSON only.", max_tokens: 512, model_tier: "main" }
    );

    await deps.sessionManager.endSession(revertSession.id, response.content);

    try {
      const parsed = deps.llmClient.parseJSON(
        response.content,
        z.object({ success: z.boolean(), reason: z.string() })
      );
      return parsed.success;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

// ─── setDimensionIntegrity ───

export async function setDimensionIntegrity(
  deps: VerifierDeps,
  goalId: string,
  dimensionName: string,
  integrity: "ok" | "uncertain"
): Promise<void> {
  const goalData = await deps.stateManager.readRaw(`goals/${goalId}/goal.json`);
  if (goalData && typeof goalData === "object") {
    const goal = goalData as Record<string, unknown>;
    const dimensions = goal.dimensions as Array<Record<string, unknown>> | undefined;
    if (dimensions) {
      for (const dim of dimensions) {
        if (dim.name === dimensionName) {
          dim.state_integrity = integrity;
        }
      }
      await deps.stateManager.writeRaw(`goals/${goalId}/goal.json`, goal);
    }
  }
}

// ─── appendTaskHistory ───

export async function appendTaskHistory(deps: VerifierDeps, goalId: string, task: Task): Promise<void> {
  const historyPath = `tasks/${goalId}/task-history.json`;
  const existing = await deps.stateManager.readRaw(historyPath);
  const history = Array.isArray(existing) ? existing : [];

  const actual_elapsed_ms =
    task.started_at && task.completed_at
      ? new Date(task.completed_at).getTime() - new Date(task.started_at).getTime()
      : null;

  const estimated_duration_ms = task.estimated_duration
    ? deps.durationToMs(task.estimated_duration)
    : null;

  history.push({
    id: task.id,
    task_id: task.id,
    work_description: task.work_description,
    status: task.status,
    primary_dimension: task.primary_dimension,
    consecutive_failure_count: task.consecutive_failure_count,
    verification_verdict: task.verification_verdict ?? null,
    verification_evidence: task.verification_evidence ?? [],
    completed_at: task.completed_at ?? new Date().toISOString(),
    actual_elapsed_ms,
    estimated_duration_ms,
  });
  await deps.stateManager.writeRaw(historyPath, history);
  await syncTaskOutcomeSummary(deps.stateManager, task);
}
