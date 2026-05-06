import { afterEach, describe, expect, it, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { ToolPermissionManager } from "../permission.js";
import { ConcurrencyController } from "../concurrency.js";
import { ShellCommandTool } from "../system/ShellCommandTool/ShellCommandTool.js";
import { ApplyPatchTool } from "../fs/ApplyPatchTool/ApplyPatchTool.js";
import { TestRunnerTool } from "../system/TestRunnerTool/TestRunnerTool.js";
import type { ExecutionPolicy } from "../../orchestrator/execution/agent-loop/execution-policy.js";
import type { ToolCallContext } from "../types.js";
import * as execMod from "../../base/utils/execFileNoThrow.js";

function makePolicy(workspaceRoot: string, overrides: Partial<ExecutionPolicy> = {}): ExecutionPolicy {
  return {
    executionProfile: "consumer",
    sandboxMode: "workspace_write",
    approvalPolicy: "never",
    networkAccess: true,
    workspaceRoot,
    protectedPaths: [],
    trustProjectInstructions: true,
    ...overrides,
  };
}

function makeContext(
  workspaceRoot: string,
  overrides: Partial<ToolCallContext> = {},
): ToolCallContext {
  return {
    cwd: workspaceRoot,
    goalId: "goal-1",
    trustBalance: 0,
    preApproved: false,
    approvalFn: async () => false,
    executionPolicy: makePolicy(workspaceRoot),
    ...overrides,
  };
}

function makeExecutor(): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(new ShellCommandTool());
  registry.register(new ApplyPatchTool());
  registry.register(new TestRunnerTool());
  return new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
  });
}

async function makeTempWorkspace(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-workspace-tools-"));
}

describe("workspace action typed tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("executes a safe shell command through the typed shell tool", async () => {
    const workspace = await makeTempWorkspace();
    const execSpy = vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
    });

    const result = await makeExecutor().execute(
      "shell_command",
      { command: "echo ok", cwd: workspace },
      makeContext(workspace),
    );

    expect(result.success).toBe(true);
    expect(execSpy).toHaveBeenCalledOnce();
    expect(execSpy.mock.calls[0]?.[2]).toMatchObject({ cwd: await fsp.realpath(workspace) });
    await fsp.rm(workspace, { recursive: true, force: true });
  });

  it("fails closed for a denied shell command before process execution", async () => {
    const workspace = await makeTempWorkspace();
    const execSpy = vi.spyOn(execMod, "execFileNoThrow").mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const result = await makeExecutor().execute(
      "shell_command",
      { command: "git push origin main", cwd: workspace },
      makeContext(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.execution).toMatchObject({
      status: "not_executed",
      reason: "policy_blocked",
    });
    expect(execSpy).not.toHaveBeenCalled();
    await fsp.rm(workspace, { recursive: true, force: true });
  });

  it("fails closed when shell input cwd escapes the execution policy workspace root", async () => {
    const contextRoot = await makeTempWorkspace();
    const policyRoot = path.join(contextRoot, "allowed");
    const outside = path.join(contextRoot, "sibling");
    await fsp.mkdir(policyRoot, { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
    const execSpy = vi.spyOn(execMod, "execFileNoThrow").mockResolvedValue({
      stdout: "should-not-run",
      stderr: "",
      exitCode: 0,
    });

    const result = await makeExecutor().execute(
      "shell_command",
      { command: "echo should-not-run", cwd: outside },
      makeContext(contextRoot, { executionPolicy: makePolicy(policyRoot) }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("cwd escapes workspace root");
    expect(result.execution).toMatchObject({
      status: "not_executed",
      reason: "policy_blocked",
    });
    expect(execSpy).not.toHaveBeenCalled();
    await fsp.rm(contextRoot, { recursive: true, force: true });
  });

  it("preserves approval-denied non-execution for patch actions", async () => {
    const workspace = await makeTempWorkspace();
    const approvalFn = vi.fn(async () => false);
    const patch = [
      "*** Begin Patch",
      "*** Add File: approved.txt",
      "+should-not-exist",
      "*** End Patch",
      "",
    ].join("\n");

    const result = await makeExecutor().execute(
      "apply_patch",
      { patch, cwd: workspace },
      makeContext(workspace, {
        approvalFn,
        executionPolicy: makePolicy(workspace, { approvalPolicy: "on_request" }),
      }),
    );

    expect(approvalFn).toHaveBeenCalledOnce();
    expect(result.execution).toMatchObject({
      status: "not_executed",
      reason: "approval_denied",
    });
    await expect(fsp.access(path.join(workspace, "approved.txt"))).rejects.toThrow();
    await fsp.rm(workspace, { recursive: true, force: true });
  });

  it("fails closed when apply_patch input cwd escapes the execution policy workspace root", async () => {
    const contextRoot = await makeTempWorkspace();
    const policyRoot = path.join(contextRoot, "allowed");
    const outside = path.join(contextRoot, "sibling");
    await fsp.mkdir(policyRoot, { recursive: true });
    await fsp.mkdir(outside, { recursive: true });
    const approvalFn = vi.fn(async () => true);
    const patch = [
      "*** Begin Patch",
      "*** Add File: escaped.txt",
      "+should-not-exist",
      "*** End Patch",
      "",
    ].join("\n");

    const result = await makeExecutor().execute(
      "apply_patch",
      { patch, cwd: outside },
      makeContext(contextRoot, { approvalFn, executionPolicy: makePolicy(policyRoot) }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("cwd escapes workspace root");
    expect(result.execution).toMatchObject({
      status: "not_executed",
      reason: "policy_blocked",
    });
    expect(approvalFn).not.toHaveBeenCalled();
    await expect(fsp.access(path.join(outside, "escaped.txt"))).rejects.toThrow();
    await fsp.rm(contextRoot, { recursive: true, force: true });
  });

  it("blocks protected patch paths without writing", async () => {
    const workspace = await makeTempWorkspace();
    const approvalFn = vi.fn(async () => true);
    const patch = [
      "*** Begin Patch",
      "*** Add File: .env",
      "+SECRET=value",
      "*** End Patch",
      "",
    ].join("\n");

    const result = await makeExecutor().execute(
      "apply_patch",
      { patch, cwd: workspace },
      makeContext(workspace, {
        approvalFn,
        executionPolicy: makePolicy(workspace, { approvalPolicy: "on_request" }),
      }),
    );

    expect(result.success).toBe(false);
    expect(result.execution).toMatchObject({
      status: "not_executed",
      reason: "policy_blocked",
    });
    expect(approvalFn).not.toHaveBeenCalled();
    await expect(fsp.access(path.join(workspace, ".env"))).rejects.toThrow();
    await fsp.rm(workspace, { recursive: true, force: true });
  });

  it("blocks rename-only patches that target protected paths without approval", async () => {
    const workspace = await makeTempWorkspace();
    const approvalFn = vi.fn(async () => true);
    await fsp.writeFile(path.join(workspace, "safe.txt"), "safe\n", "utf-8");
    const patch = [
      "diff --git a/safe.txt b/.env",
      "similarity index 100%",
      "rename from safe.txt",
      "rename to .env",
      "",
    ].join("\n");

    const result = await makeExecutor().execute(
      "apply_patch",
      { patch, cwd: workspace },
      makeContext(workspace, {
        approvalFn,
        executionPolicy: makePolicy(workspace, { approvalPolicy: "on_request" }),
      }),
    );

    expect(result.success).toBe(false);
    expect(result.execution).toMatchObject({
      status: "not_executed",
      reason: "policy_blocked",
    });
    expect(approvalFn).not.toHaveBeenCalled();
    await expect(fsp.readFile(path.join(workspace, "safe.txt"), "utf-8")).resolves.toBe("safe\n");
    await expect(fsp.access(path.join(workspace, ".env"))).rejects.toThrow();
    await fsp.rm(workspace, { recursive: true, force: true });
  });

  it("rejects non-test command args before invoking the test runner", async () => {
    const workspace = await makeTempWorkspace();
    const execSpy = vi.spyOn(execMod, "execFileNoThrow").mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const result = await makeExecutor().execute(
      "test-runner",
      { command: "npm install", cwd: workspace },
      makeContext(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.execution).toMatchObject({
      status: "not_executed",
      reason: "policy_blocked",
    });
    expect(execSpy).not.toHaveBeenCalled();
    await fsp.rm(workspace, { recursive: true, force: true });
  });

  it("rejects test-runner path args that escape the workspace before invoking the runner", async () => {
    const workspace = await makeTempWorkspace();
    const execSpy = vi.spyOn(execMod, "execFileNoThrow").mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const result = await makeExecutor().execute(
      "test-runner",
      { command: "npx vitest run --config /tmp/evil-vitest.config.ts", cwd: workspace },
      makeContext(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.execution).toMatchObject({
      status: "not_executed",
      reason: "policy_blocked",
    });
    expect(execSpy).not.toHaveBeenCalled();
    await fsp.rm(workspace, { recursive: true, force: true });
  });

  it("rejects equal-form test-runner path args that escape the workspace", async () => {
    const workspace = await makeTempWorkspace();
    const execSpy = vi.spyOn(execMod, "execFileNoThrow").mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    const result = await makeExecutor().execute(
      "test-runner",
      { command: "npx vitest run --reporter=/tmp/evil-reporter.js", cwd: workspace },
      makeContext(workspace),
    );

    expect(result.success).toBe(false);
    expect(result.execution).toMatchObject({
      status: "not_executed",
      reason: "policy_blocked",
    });
    expect(execSpy).not.toHaveBeenCalled();
    await fsp.rm(workspace, { recursive: true, force: true });
  });
});
