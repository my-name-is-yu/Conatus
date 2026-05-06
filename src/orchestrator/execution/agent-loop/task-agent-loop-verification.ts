import type { Task } from "../../../base/types/task.js";
import type { AgentLoopCommandResult } from "./agent-loop-result.js";

export function isTaskRelevantVerificationCommand(
  task: Task,
  commandResult: AgentLoopCommandResult,
): boolean {
  if (!commandResult.evidenceEligible) return false;

  const declaredVerificationCommands = new Set(task.success_criteria
    .filter((criterion) => criterion.is_blocking)
    .map((criterion) => criterion.verification_method)
    .map((method) => method.trim())
    .filter(Boolean));

  if (declaredVerificationCommands.size === 0) {
    return commandResult.evidenceSource === "tool_activity_category";
  }

  return declaredVerificationCommands.has(commandResult.command.trim());
}
