import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolCallContext } from "../../types.js";
import { KaggleWorkspacePrepareTool } from "../KaggleWorkspacePrepareTool.js";
import { ApplyPatchTool } from "../../fs/ApplyPatchTool/ApplyPatchTool.js";
import { defaultExecutionPolicy } from "../../../orchestrator/execution/agent-loop/execution-policy.js";

function makeContext(cwd = "/tmp"): ToolCallContext {
  return {
    cwd,
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

describe("KaggleWorkspacePrepareTool", () => {
  const originalPulseedHome = process.env["PULSEED_HOME"];
  const originalWorkspaceRoot = process.env["PULSEED_WORKSPACE_ROOT"];
  let pulseedHome: string;
  let workspaceRoot: string;
  let tmpDirs: string[];

  beforeEach(async () => {
    pulseedHome = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-kaggle-workspace-"));
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-workspaces-"));
    tmpDirs = [pulseedHome, workspaceRoot];
    process.env["PULSEED_HOME"] = pulseedHome;
    process.env["PULSEED_WORKSPACE_ROOT"] = workspaceRoot;
  });

  afterEach(async () => {
    if (originalPulseedHome === undefined) {
      delete process.env["PULSEED_HOME"];
    } else {
      process.env["PULSEED_HOME"] = originalPulseedHome;
    }
    if (originalWorkspaceRoot === undefined) {
      delete process.env["PULSEED_WORKSPACE_ROOT"];
    } else {
      process.env["PULSEED_WORKSPACE_ROOT"] = originalWorkspaceRoot;
    }
    await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("creates the standard workspace directories and metadata under the PulSeed workspace root", async () => {
    const tool = new KaggleWorkspacePrepareTool();
    const result = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      metric_name: "accuracy",
      metric_direction: "maximize",
      overwrite_existing: false,
      target_column: "Survived",
      submission_format_hint: "PassengerId,Survived",
      notes: "baseline",
    }, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      workspace: { path: string; state_relative_path: string };
      metadata: { path: string; state_relative_path: string };
      directories: Array<{ name: string; path: string }>;
      artifacts: { metrics_template: { state_relative_path: string }; train_log: { state_relative_path: string } };
      wait_condition_hints: {
        file_exists: { path: string; absolute_path: string };
      };
      metric_threshold_guidance: { metric: string; operator: string; metrics_artifact_state_relative_path: string };
    };
    expect(data.workspace.path).toBe(path.join(workspaceRoot, "kaggle", "titanic"));
    expect(data.workspace.state_relative_path).toBe("workspace:kaggle/titanic");
    expect(data.metadata.state_relative_path).toBe("workspace:kaggle/titanic/workspace.json");
    expect(data.directories.map((dir) => dir.name).sort()).toEqual([
      "data",
      "experiments",
      "notebooks",
      "src",
      "submissions",
    ]);
    for (const dirname of ["data", "notebooks", "src", "experiments", "submissions"]) {
      const stat = await fs.stat(path.join(workspaceRoot, "kaggle", "titanic", dirname));
      expect(stat.isDirectory()).toBe(true);
    }

    const metadata = JSON.parse(await fs.readFile(data.metadata.path, "utf-8")) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      schema_version: "kaggle-workspace-v1",
      competition: "titanic",
      target_column: "Survived",
      submission_format_hint: "PassengerId,Survived",
      metrics_schema_version: "kaggle-metrics-v1",
    });
    expect(data.artifacts.metrics_template.state_relative_path).toBe("workspace:kaggle/titanic/experiments/metrics.json");
    expect(data.artifacts.train_log.state_relative_path).toBe("workspace:kaggle/titanic/experiments/train.log");
    expect(data.wait_condition_hints.file_exists.path).toBe("workspace:kaggle/titanic/experiments/metrics.json");
    expect(data.wait_condition_hints.file_exists.absolute_path).toBe(
      path.join(workspaceRoot, "kaggle", "titanic", "experiments", "metrics.json"),
    );
    expect(data.metric_threshold_guidance).toMatchObject({
      metric: "accuracy",
      operator: "gte",
      metrics_artifact_state_relative_path: "workspace:kaggle/titanic/experiments/metrics.json",
    });
  });

  it("rejects workspace traversal", async () => {
    const tool = new KaggleWorkspacePrepareTool();
    const result = await tool.call({
      workspace: "../titanic",
      competition: "titanic",
      metric_name: "rmse",
      metric_direction: "minimize",
      overwrite_existing: false,
    }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("workspace must resolve");
    await expect(fs.stat(path.join(workspaceRoot, "titanic"))).rejects.toThrow();
  });

  it("rejects legacy state-relative kaggle-runs workspace paths", async () => {
    const tool = new KaggleWorkspacePrepareTool();
    const result = await tool.call({
      workspace: "kaggle-runs/titanic",
      competition: "titanic",
      metric_name: "rmse",
      metric_direction: "minimize",
      overwrite_existing: false,
    }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("workspace must use the PulSeed workspace root");
  });

  it("accepts the Kaggle workspace root when competition identifies the workspace", async () => {
    const tool = new KaggleWorkspacePrepareTool();
    const stateRelative = await tool.call({
      workspace: "kaggle-runs",
      competition: "titanic",
      metric_name: "rmse",
      metric_direction: "minimize",
      overwrite_existing: false,
    }, makeContext());
    const absolute = await tool.call({
      workspace: path.join(workspaceRoot, "kaggle"),
      competition: "titanic",
      metric_name: "rmse",
      metric_direction: "minimize",
      overwrite_existing: false,
    }, makeContext());

    expect(stateRelative.success).toBe(true);
    expect(absolute.success).toBe(true);
    expect((stateRelative.data as { workspace: { state_relative_path: string } }).workspace.state_relative_path).toBe("workspace:kaggle/titanic");
    expect((absolute.data as { workspace: { state_relative_path: string } }).workspace.state_relative_path).toBe("workspace:kaggle/titanic");
  });

  it("imports an existing real Kaggle workspace into the canonical PulSeed workspace root", async () => {
    const tool = new KaggleWorkspacePrepareTool();
    const source = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-existing-kaggle-"));
    tmpDirs.push(source);
    await fs.mkdir(path.join(source, "data", "raw"), { recursive: true });
    await fs.mkdir(path.join(source, "scripts"), { recursive: true });
    await fs.writeFile(path.join(source, "data", "raw", "train.csv"), "target,x\n1,0\n");
    await fs.writeFile(path.join(source, "scripts", "train.py"), "print('train')\n");

    const result = await tool.call({
      workspace: source,
      competition: "playground-series-s6e4",
      metric_name: "balanced_accuracy",
      metric_direction: "maximize",
      overwrite_existing: true,
    }, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as {
      workspace: { path: string; state_relative_path: string };
      imported_workspace: { source_path: string; copied: boolean; overwritten: boolean; entry_count: number };
    };
    expect(data.workspace.path).toBe(path.join(workspaceRoot, "kaggle", "playground-series-s6e4"));
    expect(data.workspace.state_relative_path).toBe("workspace:kaggle/playground-series-s6e4");
    expect(data.imported_workspace).toMatchObject({
      source_path: source,
      copied: true,
      overwritten: false,
    });
    expect(data.imported_workspace.entry_count).toBeGreaterThan(0);
    await expect(fs.readFile(
      path.join(workspaceRoot, "kaggle", "playground-series-s6e4", "data", "raw", "train.csv"),
      "utf-8",
    )).resolves.toContain("target,x");
    await expect(fs.readFile(
      path.join(workspaceRoot, "kaggle", "playground-series-s6e4", "scripts", "train.py"),
      "utf-8",
    )).resolves.toContain("print('train')");
  });

  it("lets AgentLoop apply_patch edit managed workspace files while protected .pulseed remains blocked", async () => {
    const prepareTool = new KaggleWorkspacePrepareTool();
    const prepared = await prepareTool.call({
      workspace: "titanic",
      competition: "titanic",
      metric_name: "accuracy",
      metric_direction: "maximize",
      overwrite_existing: false,
    }, makeContext());
    expect(prepared.success).toBe(true);
    const workspacePath = (prepared.data as { workspace: { path: string } }).workspace.path;

    const patchTool = new ApplyPatchTool();
    const policy = {
      ...defaultExecutionPolicy(workspacePath),
      protectedPaths: [pulseedHome],
    };
    const context: ToolCallContext = {
      ...makeContext(workspacePath),
      executionPolicy: policy,
    };

    const workspacePatch = [
      "*** Begin Patch",
      "*** Add File: notes.md",
      "+workspace editable",
      "*** End Patch",
      "",
    ].join("\n");
    const workspaceResult = await patchTool.call({ patch: workspacePatch, checkOnly: false }, context);
    expect(workspaceResult.success).toBe(true);
    await expect(fs.readFile(path.join(workspacePath, "notes.md"), "utf-8")).resolves.toBe("workspace editable\n");

    const protectedPatch = [
      "*** Begin Patch",
      `*** Add File: ${path.join(pulseedHome, "runtime-state.txt")}`,
      "+blocked",
      "*** End Patch",
      "",
    ].join("\n");
    const protectedResult = await patchTool.call({ patch: protectedPatch, checkOnly: false }, context);
    expect(protectedResult.success).toBe(false);
    expect(protectedResult.execution).toMatchObject({ status: "not_executed", reason: "policy_blocked" });
    await expect(fs.stat(path.join(pulseedHome, "runtime-state.txt"))).rejects.toThrow();
  });

  it("rejects absolute workspace paths outside the fixed competition root", async () => {
    const tool = new KaggleWorkspacePrepareTool();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-kaggle-outside-"));
    tmpDirs.push(outside);
    const result = await tool.call({
      workspace: outside,
      competition: "titanic",
      metric_name: "rmse",
      metric_direction: "minimize",
      overwrite_existing: false,
    }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("workspace must resolve");
  });

  it("rejects symlink escape under kaggle-runs", async () => {
    const tool = new KaggleWorkspacePrepareTool();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-kaggle-symlink-target-"));
    tmpDirs.push(outside);
    await fs.mkdir(path.join(workspaceRoot, "kaggle"), { recursive: true });
    await fs.symlink(outside, path.join(workspaceRoot, "kaggle", "titanic"), "dir");

    const result = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      metric_name: "rmse",
      metric_direction: "minimize",
      overwrite_existing: false,
    }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("must not be a symlink");
    await expect(fs.stat(path.join(outside, "workspace.json"))).rejects.toThrow();
  });

  it("rejects symlinks that point to another location inside the PulSeed workspace root", async () => {
    const tool = new KaggleWorkspacePrepareTool();
    await fs.mkdir(path.join(workspaceRoot, "other-workspace-subtree"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "kaggle"), { recursive: true });
    await fs.symlink(
      path.join(workspaceRoot, "other-workspace-subtree"),
      path.join(workspaceRoot, "kaggle", "titanic"),
      "dir",
    );

    const result = await tool.call({
      workspace: "titanic",
      competition: "titanic",
      metric_name: "rmse",
      metric_direction: "minimize",
      overwrite_existing: false,
    }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("must not be a symlink");
    await expect(fs.stat(path.join(workspaceRoot, "other-workspace-subtree", "workspace.json"))).rejects.toThrow();
  });

});
