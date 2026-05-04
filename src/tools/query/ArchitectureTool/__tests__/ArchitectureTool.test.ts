import { describe, expect, it } from "vitest";
import { ArchitectureTool } from "../ArchitectureTool.js";

describe("ArchitectureTool", () => {
  it("describes direct tool use without stale delegate-only wording", async () => {
    const tool = new ArchitectureTool();
    const result = await tool.call({}, {
      cwd: "/repo",
      goalId: "goal-1",
      trustBalance: 0,
      preApproved: false,
      approvalFn: async () => false,
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      core_concept: {
        durable_loop: expect.stringContaining("observe"),
        execution_boundary: expect.stringContaining("uses available tools directly"),
      },
      layers: {
        "Layer 5": expect.stringContaining("DurableLoop"),
      },
      modules: {
        DurableLoop: expect.stringContaining("Main orchestration loop"),
      },
    });
    expect(result.data).not.toHaveProperty("core_concept.core_loop");
    expect(JSON.stringify(result.data)).not.toContain("PulSeed always delegates");
    expect(JSON.stringify(result.data)).not.toContain("state read/write only");
    expect(JSON.stringify(result.data)).not.toContain("CoreLoop");
  });
});
