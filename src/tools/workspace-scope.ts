import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { ToolCallContext } from "./types.js";
import { expandTildePath } from "./fs/FileValidationTool/protected-path-policy.js";

export interface WorkspaceScopeValidationResult {
  valid: boolean;
  resolved: string;
  workspaceRoot: string;
  error?: string;
}

export function resolveWorkspaceCwd(
  requestedCwd: string | undefined,
  context: ToolCallContext,
): WorkspaceScopeValidationResult {
  const baseCwd = canonicalPath(context.cwd);
  const workspaceRoot = canonicalPath(context.executionPolicy?.workspaceRoot ?? baseCwd);
  const rawCwd = requestedCwd?.trim() ? expandTildePath(requestedCwd.trim()) : baseCwd;
  const resolved = canonicalPath(isAbsolute(rawCwd) ? rawCwd : resolve(baseCwd, rawCwd));

  if (!context.executionPolicy) {
    return {
      valid: true,
      resolved,
      workspaceRoot,
    };
  }

  if (!isInsideOrEqual(resolved, workspaceRoot)) {
    return {
      valid: false,
      resolved,
      workspaceRoot,
      error: `cwd escapes workspace root: ${resolved}`,
    };
  }

  return {
    valid: true,
    resolved,
    workspaceRoot,
  };
}

export function isInsideOrEqual(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveWorkspacePath(
  requestedPath: string,
  cwd: string,
  workspaceRoot: string,
): WorkspaceScopeValidationResult {
  const root = canonicalPath(workspaceRoot);
  const baseCwd = canonicalPath(cwd);
  const rawPath = expandTildePath(requestedPath.trim());
  const resolved = canonicalPath(isAbsolute(rawPath) ? rawPath : resolve(baseCwd, rawPath));

  if (!isInsideOrEqual(resolved, root)) {
    return {
      valid: false,
      resolved,
      workspaceRoot: root,
      error: `path escapes workspace root: ${resolved}`,
    };
  }

  return {
    valid: true,
    resolved,
    workspaceRoot: root,
  };
}

function canonicalPath(value: string): string {
  const expanded = expandTildePath(value);
  const resolved = resolve(expanded);
  try {
    return realpathSync(resolved);
  } catch {
    const missingParts: string[] = [];
    let current = resolved;
    while (true) {
      const parent = dirname(current);
      if (parent === current) return resolved;
      missingParts.unshift(basename(current));
      current = parent;
      try {
        return resolve(realpathSync(current), ...missingParts);
      } catch {
        continue;
      }
    }
  }
}
