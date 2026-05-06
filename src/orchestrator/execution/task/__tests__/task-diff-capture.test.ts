import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { captureExecutionDiffArtifacts, type ExecFileSyncFn } from "../task-diff-capture.js";
import { makeTempDir } from "../../../../../tests/helpers/temp-dir.js";

function makeGitWorkspace(): string {
  const workspace = makeTempDir();
  fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
  return workspace;
}

function makeExecFileSync(outputs: Record<string, string>, thrownOutputs: Record<string, string> = {}): ExecFileSyncFn {
  return ((cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    if (key in thrownOutputs) {
      const error = new Error("command failed") as Error & { stdout?: string };
      error.stdout = thrownOutputs[key];
      throw error;
    }
    return outputs[key] ?? "";
  }) as ExecFileSyncFn;
}

describe("captureExecutionDiffArtifacts", () => {
  it("collects tracked file diffs and changed paths", () => {
    const workspace = makeGitWorkspace();
    try {
      const execFileSyncFn = makeExecFileSync({
        "git diff --name-only": "src/example.ts\n",
        "git ls-files --others --exclude-standard": "",
        "git diff -- src/example.ts": "diff --git a/src/example.ts b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
      });

      const result = captureExecutionDiffArtifacts(execFileSyncFn, workspace);

      expect(result.changedPaths).toEqual(["src/example.ts"]);
      expect(result.fileDiffs).toEqual([
        expect.objectContaining({
          path: "src/example.ts",
          patch: expect.stringContaining("+new"),
        }),
      ]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("captures untracked file diffs from git diff --no-index output", () => {
    const workspace = makeGitWorkspace();
    try {
      const execFileSyncFn = makeExecFileSync(
        {
          "git diff --name-only": "",
          "git ls-files --others --exclude-standard": "src/new-file.ts\n",
          "git diff -- src/new-file.ts": "",
        },
        {
          "git diff --no-index -- /dev/null src/new-file.ts": [
            "diff --git a/src/new-file.ts b/src/new-file.ts",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/src/new-file.ts",
            "@@ -0,0 +1 @@",
            "+export const created = true;",
            "",
          ].join("\n"),
        },
      );

      const result = captureExecutionDiffArtifacts(execFileSyncFn, workspace);

      expect(result.changedPaths).toEqual(["src/new-file.ts"]);
      expect(result.fileDiffs).toEqual([
        expect.objectContaining({
          path: "src/new-file.ts",
          patch: expect.stringContaining("new file mode 100644"),
        }),
      ]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("captures staged file diffs without counting fallback paths as git-backed changes", () => {
    const workspace = makeGitWorkspace();
    try {
      fs.mkdirSync(path.join(workspace, "reports"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "reports", "clean.md"), "reported by tool\n", "utf-8");
      const execFileSyncFn = makeExecFileSync({
        "git diff --name-only": "",
        "git diff --cached --name-only": "reports/staged.md\n",
        "git ls-files --others --exclude-standard": "",
        "git diff -- reports/staged.md": "",
        "git diff --cached -- reports/staged.md": [
          "diff --git a/reports/staged.md b/reports/staged.md",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/reports/staged.md",
          "@@ -0,0 +1 @@",
          "+staged output",
          "",
        ].join("\n"),
        "git diff -- reports/clean.md": "",
        "git diff --cached -- reports/clean.md": "",
      });

      const result = captureExecutionDiffArtifacts(execFileSyncFn, workspace, {
        fallbackChangedPaths: ["reports/clean.md", "../outside.md"],
      });

      expect(result.changedPaths).toEqual(["reports/staged.md"]);
      expect(result.fileDiffs).toEqual([
        expect.objectContaining({
          path: "reports/staged.md",
          patch: expect.stringContaining("+staged output"),
        }),
      ]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("ignores per-path diff read failures after collecting changed paths", () => {
    const workspace = makeGitWorkspace();
    try {
      const execFileSyncFn = makeExecFileSync(
        {
          "git diff --name-only": "src/example.ts\n",
          "git ls-files --others --exclude-standard": "",
        },
        {
          "git diff -- src/example.ts": "",
        },
      );

      const result = captureExecutionDiffArtifacts(execFileSyncFn, workspace);

      expect(result.available).toBe(true);
      expect(result.changedPaths).toEqual(["src/example.ts"]);
      expect(result.fileDiffs).toEqual([]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("renders non-git fallback file diffs from concrete changed paths without probing git", () => {
    const workspace = makeTempDir();
    try {
      fs.mkdirSync(path.join(workspace, "reports"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "reports", "hgb.json"), "{\"score\":0.95}\n", "utf-8");
      const execFileSyncFn = vi.fn(makeExecFileSync({}, {
        "git diff --name-only": "",
        "git ls-files --others --exclude-standard": "",
      }));

      const result = captureExecutionDiffArtifacts(execFileSyncFn, workspace, {
        fallbackChangedPaths: ["reports/hgb.json"],
      });

      expect(result.available).toBe(true);
      expect(result.changedPaths).toEqual(["reports/hgb.json"]);
      expect(result.fileDiffs).toEqual([
        expect.objectContaining({
          path: "reports/hgb.json",
          patch: expect.stringContaining("+{\"score\":0.95}"),
        }),
      ]);
      expect(execFileSyncFn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("omits non-git fallback content when a changed path resolves outside the workspace", () => {
    const workspace = makeTempDir();
    const outside = makeTempDir();
    try {
      fs.mkdirSync(path.join(workspace, "reports"), { recursive: true });
      fs.writeFileSync(path.join(outside, "secret.txt"), "outside-secret\n", "utf-8");
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "reports", "secret.txt"));

      const result = captureExecutionDiffArtifacts(vi.fn(), workspace, {
        fallbackChangedPaths: ["reports/secret.txt"],
      });

      expect(result.available).toBe(true);
      expect(result.changedPaths).toEqual(["reports/secret.txt"]);
      expect(result.fileDiffs).toEqual([
        expect.objectContaining({
          path: "reports/secret.txt",
          patch: expect.stringContaining("path resolves outside the workspace"),
        }),
      ]);
      expect(result.fileDiffs[0]?.patch).not.toContain("outside-secret");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
