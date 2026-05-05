import type { StateManager } from "../../../base/state/state-manager.js";
import type { Task } from "../../../base/types/task.js";

const WORKSPACE_PATH_CONSTRAINT_PREFIX = "workspace_path:";

function workspacePathFromConstraints(constraints: readonly string[] | undefined): string | null {
  const constraint = constraints?.find((value) => value.startsWith(WORKSPACE_PATH_CONSTRAINT_PREFIX));
  const workspacePath = constraint?.slice(WORKSPACE_PATH_CONSTRAINT_PREFIX.length).trim();
  return workspacePath && workspacePath.length > 0 ? workspacePath : null;
}

export async function resolveTaskWorkspacePath(
  input: {
    stateManager: StateManager;
    task: Task;
    fallbackCwd?: string;
  },
): Promise<string | undefined> {
  const taskWorkspacePath = workspacePathFromConstraints(input.task.constraints);
  if (taskWorkspacePath) return taskWorkspacePath;

  try {
    const goal = await input.stateManager.loadGoal(input.task.goal_id);
    const goalWorkspacePath = workspacePathFromConstraints(goal?.constraints);
    if (goalWorkspacePath) return goalWorkspacePath;
  } catch {
    // Missing or unreadable goal state should not block task execution.
  }

  return input.fallbackCwd;
}

