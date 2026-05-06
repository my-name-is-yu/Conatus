import * as path from "node:path";

export const WORKSPACE_PATH_CONSTRAINT_PREFIX = "workspace_path:";

export function resolveWorkspacePath(workspacePath: string, cwd = process.cwd()): string {
  return path.resolve(cwd, workspacePath);
}

export function formatWorkspacePathConstraint(workspacePath: string): string {
  return `${WORKSPACE_PATH_CONSTRAINT_PREFIX}${workspacePath}`;
}

export function extractWorkspacePathConstraint(constraints: readonly string[] | undefined): string | null {
  const constraint = constraints?.find((value) => value.startsWith(WORKSPACE_PATH_CONSTRAINT_PREFIX));
  const workspacePath = constraint?.slice(WORKSPACE_PATH_CONSTRAINT_PREFIX.length).trim();
  return workspacePath && workspacePath.length > 0 ? workspacePath : null;
}

export function upsertWorkspacePathConstraint(constraints: string[], workspacePath: string): void {
  const constraint = formatWorkspacePathConstraint(workspacePath);
  const existingIdx = constraints.findIndex((value) => value.startsWith(WORKSPACE_PATH_CONSTRAINT_PREFIX));
  if (existingIdx >= 0) {
    constraints[existingIdx] = constraint;
  } else {
    constraints.push(constraint);
  }
}
