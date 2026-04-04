import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolCallContext } from "../../types.js";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));
vi.mock("util", () => ({
  promisify: (fn: unknown) => fn,
}));

const makeContext = (): ToolCallContext => ({
  cwd: "/repo",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
});

async function getToolAndMock() {
  const childProcess = await import("child_process");
  const mockedExecFile = vi.mocked(childProcess.execFile);

  // Re-import to get fresh module after mock setup
  const { GitDiffTool } = await import("../git-diff.js");
  const tool = new GitDiffTool();
  return { tool, mockedExecFile };
}

describe("GitDiffTool", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("metadata is correct", async () => {
    const { GitDiffTool } = await import("../git-diff.js");
    const tool = new GitDiffTool();
    expect(tool.metadata.name).toBe("git_diff");
    expect(tool.metadata.permissionLevel).toBe("read_only");
    expect(tool.metadata.isReadOnly).toBe(true);
    expect(tool.metadata.isDestructive).toBe(false);
    expect(tool.metadata.maxConcurrency).toBe(5);
    expect(tool.metadata.tags).toEqual(expect.arrayContaining(["git", "diff", "changes", "verification"]));
  });

  it("returns unstaged diff", async () => {
    const { tool, mockedExecFile } = await getToolAndMock();
    mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, "diff output here\nline2", "");
    });

    const result = await tool.call({ target: "unstaged", maxLines: 200 }, makeContext());
    expect(result.success).toBe(true);
    expect(result.data).toContain("diff output here");
  });

  it("returns staged diff", async () => {
    const { tool, mockedExecFile } = await getToolAndMock();
    mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, "staged diff content", "");
    });

    const result = await tool.call({ target: "staged", maxLines: 200 }, makeContext());
    expect(result.success).toBe(true);
    expect(result.data).toContain("staged diff content");
  });

  it("returns commit diff", async () => {
    const { tool, mockedExecFile } = await getToolAndMock();
    mockedExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      expect(args).toContain("abc123^..abc123");
      cb(null, "commit diff", "");
    });

    const result = await tool.call({ target: "commit", ref: "abc123", maxLines: 200 }, makeContext());
    expect(result.success).toBe(true);
  });

  it("filters by path", async () => {
    const { tool, mockedExecFile } = await getToolAndMock();
    mockedExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      expect(args).toContain("--");
      expect(args).toContain("src/foo.ts");
      cb(null, "path filtered diff", "");
    });

    const result = await tool.call({ target: "unstaged", path: "src/foo.ts", maxLines: 200 }, makeContext());
    expect(result.success).toBe(true);
  });

  it("truncates long output", async () => {
    const { tool, mockedExecFile } = await getToolAndMock();
    const manyLines = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
    mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, manyLines, "");
    });

    const result = await tool.call({ target: "unstaged", maxLines: 10 }, makeContext());
    expect(result.success).toBe(true);
    expect(result.data as string).toContain("[truncated]");
    const lines = (result.data as string).split("\n").filter((l) => !l.includes("[truncated]"));
    expect(lines.length).toBeLessThanOrEqual(10);
  });

  it("rejects invalid ref - semicolon", async () => {
    const { tool } = await getToolAndMock();
    const result = await tool.call({ target: "branch", ref: "main;rm -rf /", maxLines: 200 }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid ref");
  });

  it("rejects invalid ref - dollar sign", async () => {
    const { tool } = await getToolAndMock();
    const result = await tool.call({ target: "commit", ref: "$(evil)", maxLines: 200 }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid ref");
  });

  it("rejects invalid ref - backtick", async () => {
    const { tool } = await getToolAndMock();
    const result = await tool.call({ target: "branch", ref: "`whoami`", maxLines: 200 }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid ref");
  });

  it("rejects invalid path - shell injection", async () => {
    const { tool } = await getToolAndMock();
    const result = await tool.call({ target: "unstaged", path: "src/foo.ts; rm -rf /", maxLines: 200 }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid path");
  });

  it("handles no changes gracefully", async () => {
    const { tool, mockedExecFile } = await getToolAndMock();
    mockedExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, "", "");
    });

    const result = await tool.call({ target: "unstaged", maxLines: 200 }, makeContext());
    expect(result.success).toBe(true);
    expect(result.data).toBe("");
    expect(result.summary).toContain("No changes");
  });

  it("checkPermissions returns allowed", async () => {
    const { tool } = await getToolAndMock();
    const result = await tool.checkPermissions({ target: "unstaged", maxLines: 200 }, makeContext());
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns true", async () => {
    const { tool } = await getToolAndMock();
    expect(tool.isConcurrencySafe({ target: "unstaged", maxLines: 200 })).toBe(true);
  });
});
