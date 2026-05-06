import type { StateManager } from "../../../base/state/state-manager.js";
import type { Task } from "../../../base/types/task.js";
import { extractWorkspacePathConstraint, resolveWorkspacePath } from "../../../base/utils/workspace-path.js";

export async function resolveGoalWorkspacePath(
  input: {
    stateManager: StateManager;
    goalId: string;
    fallbackCwd?: string;
  },
): Promise<string | undefined> {
  try {
    const goal = await input.stateManager.loadGoal(input.goalId);
    const goalWorkspacePath = extractWorkspacePathConstraint(goal?.constraints);
    if (goalWorkspacePath) return resolveWorkspacePath(goalWorkspacePath, input.fallbackCwd);
  } catch {
    // Missing or unreadable goal state should not block task generation.
  }

  return input.fallbackCwd ? resolveWorkspacePath(input.fallbackCwd) : undefined;
}

export async function resolveTaskWorkspacePath(
  input: {
    stateManager: StateManager;
    task: Task;
    fallbackCwd?: string;
  },
): Promise<string | undefined> {
  const taskWorkspacePath = extractWorkspacePathConstraint(input.task.constraints);
  if (taskWorkspacePath) return resolveWorkspacePath(taskWorkspacePath, input.fallbackCwd);

  try {
    const goalWorkspacePath = await resolveGoalWorkspacePath({
      stateManager: input.stateManager,
      goalId: input.task.goal_id,
      fallbackCwd: input.fallbackCwd,
    });
    if (goalWorkspacePath) return goalWorkspacePath;
  } catch {
    // Missing or unreadable goal state should not block task execution.
  }

  return input.fallbackCwd ? resolveWorkspacePath(input.fallbackCwd) : undefined;
}
