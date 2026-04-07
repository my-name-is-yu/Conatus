import type { Logger } from "../../../runtime/logger.js";
import type { AgentResult } from "../adapter-layer.js";
import type { ToolExecutor } from "../../../tools/executor.js";

interface FinalizeSuccessfulExecutionParams {
  executionResult: AgentResult;
  goalId: string;
  healthCheckEnabled: boolean;
  runPostExecutionHealthCheck: () => Promise<{ healthy: boolean; output: string }>;
  verifyExecutionWithGitDiff: (toolExecutor: ToolExecutor | undefined, goalId: string) => Promise<{ verified: boolean; diffSummary: string }>;
  toolExecutor?: ToolExecutor;
  logger?: Logger;
}

export async function finalizeSuccessfulExecution(
  params: FinalizeSuccessfulExecutionParams
): Promise<AgentResult> {
  const {
    executionResult,
    goalId,
    healthCheckEnabled,
    runPostExecutionHealthCheck,
    verifyExecutionWithGitDiff,
    toolExecutor,
    logger,
  } = params;

  if (!executionResult.success) return executionResult;

  if (healthCheckEnabled) {
    const healthCheck = await runPostExecutionHealthCheck();
    if (!healthCheck.healthy) {
      logger?.warn(`[TaskLifecycle] Post-execution health check FAILED: ${healthCheck.output}`);
      executionResult.success = false;
      executionResult.output = (executionResult.output || "") +
        `\n\n[Health Check Failed]\n${healthCheck.output}`;
      return executionResult;
    }
  }

  if (toolExecutor) {
    const diffCheck = await verifyExecutionWithGitDiff(toolExecutor, goalId);
    logger?.info(
      `[TaskLifecycle] Git diff verification: ${diffCheck.diffSummary || "no changes"}`,
      { verified: diffCheck.verified }
    );
    if (!diffCheck.verified) {
      logger?.warn(
        "[TaskLifecycle] Git diff found no file changes after successful task execution",
        { diffSummary: diffCheck.diffSummary }
      );
    }
  }

  return executionResult;
}
