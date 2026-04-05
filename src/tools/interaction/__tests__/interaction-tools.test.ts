import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CreatePlanTool, CreatePlanInputSchema } from "../create-plan.js";
import { ReadPlanTool, ReadPlanInputSchema } from "../read-plan.js";
import type { ToolCallContext } from "../../types.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

function makeContext(): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

describe("CreatePlanTool", () => {
  const tool = new CreatePlanTool();
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-test-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("has correct metadata", () => {
    expect(tool.metadata.name).toBe("create-plan");
    expect(tool.metadata.isReadOnly).toBe(false);
    expect(tool.metadata.isDestructive).toBe(false);
    expect(tool.metadata.tags).toContain("plan");
  });

  it("description returns non-empty string", () => {
    expect(tool.description()).toBeTruthy();
  });

  it("checkPermissions returns allowed", async () => {
    const result = await tool.checkPermissions(
      { plan_id: "my-plan", title: "T", content: "C" },
      makeContext()
    );
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns true", () => {
    expect(tool.isConcurrencySafe({ plan_id: "x", title: "T", content: "C" })).toBe(true);
  });

  it("writes plan file with frontmatter", async () => {
    const result = await tool.call(
      { plan_id: "my-plan", title: "My Plan", content: "Step 1\nStep 2" },
      makeContext()
    );
    expect(result.success).toBe(true);
    const data = result.data as { plan_id: string; path: string; created_at: string };
    expect(data.plan_id).toBe("my-plan");
    expect(data.path).toContain("my-plan.md");
    const fileContent = await fs.readFile(data.path, "utf8");
    expect(fileContent).toContain("title: My Plan");
    expect(fileContent).toContain("created_at:");
    expect(fileContent).toContain("Step 1");
  });

  it("creates decisions directory if missing", async () => {
    const result = await tool.call(
      { plan_id: "new-plan", title: "T", content: "C" },
      makeContext()
    );
    expect(result.success).toBe(true);
    const decDir = path.join(tmpDir, ".pulseed", "decisions");
    const stat = await fs.stat(decDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("Zod rejects invalid plan_id with path traversal chars", () => {
    const parsed = CreatePlanInputSchema.safeParse({
      plan_id: "../evil",
      title: "T",
      content: "C",
    });
    expect(parsed.success).toBe(false);
  });

  it("Zod rejects plan_id with slashes", () => {
    const parsed = CreatePlanInputSchema.safeParse({
      plan_id: "foo/bar",
      title: "T",
      content: "C",
    });
    expect(parsed.success).toBe(false);
  });

  it("Zod accepts valid plan_id", () => {
    const parsed = CreatePlanInputSchema.safeParse({
      plan_id: "my-plan-123",
      title: "T",
      content: "C",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("ReadPlanTool", () => {
  const tool = new ReadPlanTool();
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-test-"));
    vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("has correct metadata", () => {
    expect(tool.metadata.name).toBe("read-plan");
    expect(tool.metadata.isReadOnly).toBe(true);
    expect(tool.metadata.isDestructive).toBe(false);
    expect(tool.metadata.tags).toContain("plan");
  });

  it("checkPermissions returns allowed", async () => {
    const result = await tool.checkPermissions({ plan_id: "x" }, makeContext());
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns true", () => {
    expect(tool.isConcurrencySafe({ plan_id: "x" })).toBe(true);
  });

  it("reads existing plan file", async () => {
    const decDir = path.join(tmpDir, ".pulseed", "decisions");
    await fs.mkdir(decDir, { recursive: true });
    await fs.writeFile(path.join(decDir, "test-plan.md"), "---\ntitle: T\n---\n\nHello", "utf8");

    const result = await tool.call({ plan_id: "test-plan" }, makeContext());
    expect(result.success).toBe(true);
    const data = result.data as { plan_id: string; content: string };
    expect(data.plan_id).toBe("test-plan");
    expect(data.content).toContain("Hello");
  });

  it("returns failure when plan not found", async () => {
    const result = await tool.call({ plan_id: "missing-plan" }, makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toContain("missing-plan");
  });

  it("Zod rejects invalid plan_id", () => {
    const parsed = ReadPlanInputSchema.safeParse({ plan_id: "foo/bar" });
    expect(parsed.success).toBe(false);
  });

  it("Zod accepts valid plan_id", () => {
    const parsed = ReadPlanInputSchema.safeParse({ plan_id: "my-plan-123" });
    expect(parsed.success).toBe(true);
  });
});
