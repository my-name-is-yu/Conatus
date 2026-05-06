import type { VerificationFileDiff } from "../../../base/types/task.js";
import * as fs from "node:fs";
import * as path from "node:path";

export type ExecFileSyncFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; encoding: "utf-8"; stdio?: "pipe" }
) => string;

export interface ExecutionDiffArtifacts {
  available: boolean;
  changedPaths: string[];
  fileDiffs: VerificationFileDiff[];
}

export interface CaptureExecutionDiffOptions {
  fallbackChangedPaths?: string[];
  maxFallbackDiffBytes?: number;
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function readStdoutFromExecError(error: unknown): string | null {
  if (
    error &&
    typeof error === "object" &&
    "stdout" in error &&
    typeof (error as { stdout?: unknown }).stdout === "string"
  ) {
    const stdout = (error as { stdout: string }).stdout;
    return stdout.length > 0 ? stdout : null;
  }

  if (
    error &&
    typeof error === "object" &&
    "stdout" in error &&
    Buffer.isBuffer((error as { stdout?: unknown }).stdout)
  ) {
    const stdout = ((error as { stdout: Buffer }).stdout).toString("utf-8");
    return stdout.length > 0 ? stdout : null;
  }

  return null;
}

function runGitRead(
  execFileSyncFn: ExecFileSyncFn,
  cwd: string,
  args: string[],
): string | null {
  try {
    return execFileSyncFn("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
  } catch (error) {
    return readStdoutFromExecError(error);
  }
}

export function captureExecutionDiffArtifacts(
  execFileSyncFn: ExecFileSyncFn,
  cwd: string,
  options: CaptureExecutionDiffOptions = {},
): ExecutionDiffArtifacts {
  const fallbackPaths = uniqueNonEmpty(options.fallbackChangedPaths ?? [])
    .filter((filePath) => isSafeRelativePath(cwd, filePath));
  if (!hasGitMetadata(cwd)) {
    return renderFallbackDiffArtifacts(cwd, fallbackPaths, options.maxFallbackDiffBytes);
  }

  const trackedOutput = runGitRead(execFileSyncFn, cwd, ["diff", "--name-only"]);
  const stagedOutput = runGitRead(execFileSyncFn, cwd, ["diff", "--cached", "--name-only"]);
  const untrackedOutput = runGitRead(execFileSyncFn, cwd, ["ls-files", "--others", "--exclude-standard"]);

  const available = trackedOutput !== null || stagedOutput !== null || untrackedOutput !== null;
  if (!available) {
    return renderFallbackDiffArtifacts(cwd, fallbackPaths, options.maxFallbackDiffBytes);
  }

  const trackedPaths = (trackedOutput ?? "").split("\n");
  const stagedPaths = (stagedOutput ?? "").split("\n");
  const untrackedPaths = (untrackedOutput ?? "").split("\n");
  const changedPaths = uniqueNonEmpty([...trackedPaths, ...stagedPaths, ...untrackedPaths])
    .filter((filePath) => isSafeRelativePath(cwd, filePath));
  const untrackedSet = new Set(uniqueNonEmpty(untrackedPaths));

  const fileDiffs = changedPaths.flatMap((path) => {
    const trackedPatch = runGitRead(execFileSyncFn, cwd, ["diff", "--", path])?.trim() ?? "";
    const stagedPatch = runGitRead(execFileSyncFn, cwd, ["diff", "--cached", "--", path])?.trim() ?? "";
    const patches = [trackedPatch, stagedPatch].filter((patch) => patch.length > 0);
    if (patches.length > 0) return [{ path, patch: patches.join("\n") }];

    if (!untrackedSet.has(path)) {
      return [];
    }

    const untrackedPatch = runGitRead(execFileSyncFn, cwd, ["diff", "--no-index", "--", "/dev/null", path])?.trim() ?? "";
    return untrackedPatch.length > 0 ? [{ path, patch: untrackedPatch }] : [];
  });

  return { available: true, changedPaths, fileDiffs };
}

function renderFallbackDiffArtifacts(
  cwd: string,
  fallbackPaths: string[],
  maxFallbackDiffBytes = 200_000,
): ExecutionDiffArtifacts {
  if (fallbackPaths.length === 0) {
    return { available: false, changedPaths: [], fileDiffs: [] };
  }
  return {
    available: true,
    changedPaths: fallbackPaths,
    fileDiffs: fallbackPaths.flatMap((filePath) =>
      renderCurrentFileDiff(cwd, filePath, maxFallbackDiffBytes)
    ),
  };
}

function hasGitMetadata(cwd: string): boolean {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function isSafeRelativePath(cwd: string, filePath: string): boolean {
  if (!filePath || filePath.includes("\0") || path.isAbsolute(filePath)) return false;
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, filePath);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function renderCurrentFileDiff(cwd: string, filePath: string, maxBytes: number): VerificationFileDiff[] {
  const resolved = path.resolve(cwd, filePath);
  try {
    const root = fs.realpathSync(cwd);
    const realResolved = fs.realpathSync(resolved);
    if (!isWithinRoot(root, realResolved)) {
      return [{
        path: filePath,
        patch: [
          `diff --git a/${filePath} b/${filePath}`,
          `--- a/${filePath}`,
          `+++ b/${filePath}`,
          "@@ -0,0 +1 @@",
          "+[non-git evidence] path resolves outside the workspace; content omitted",
          "",
        ].join("\n"),
      }];
    }
    const stat = fs.statSync(realResolved);
    if (!stat.isFile()) {
      return [{
        path: filePath,
        patch: [
          `diff --git a/${filePath} b/${filePath}`,
          `--- a/${filePath}`,
          `+++ b/${filePath}`,
          "@@ -0,0 +1 @@",
          `+[non-git evidence] path exists but is not a regular file (${stat.isDirectory() ? "directory" : "special file"})`,
          "",
        ].join("\n"),
      }];
    }
    if (stat.size > maxBytes) {
      return [{
        path: filePath,
        patch: [
          `diff --git a/${filePath} b/${filePath}`,
          `--- a/${filePath}`,
          `+++ b/${filePath}`,
          "@@ -0,0 +1 @@",
          `+[non-git evidence] file exists; diff omitted because size ${stat.size} exceeds ${maxBytes} bytes`,
          "",
        ].join("\n"),
      }];
    }
    const content = fs.readFileSync(realResolved, "utf-8");
    if (content.includes("\0")) {
      return [{
        path: filePath,
        patch: [
          `diff --git a/${filePath} b/${filePath}`,
          "new file mode 100644",
          "--- /dev/null",
          `+++ b/${filePath}`,
          "@@ -0,0 +1 @@",
          `+[non-git evidence] binary file exists; size ${stat.size} bytes`,
          "",
        ].join("\n"),
      }];
    }
    const lines = content.length === 0
      ? []
      : content.replace(/\n$/, "").split("\n");
    return [{
      path: filePath,
      patch: [
        `diff --git a/${filePath} b/${filePath}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${filePath}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
        "",
      ].join("\n"),
    }];
  } catch {
    return [{
      path: filePath,
      patch: [
        `diff --git a/${filePath} b/${filePath}`,
        `--- a/${filePath}`,
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-[non-git evidence] path was reported changed but is absent after execution",
        "",
      ].join("\n"),
    }];
  }
}
