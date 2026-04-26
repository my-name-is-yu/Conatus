import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeReadContextTool } from "../../CodeReadContextTool/CodeReadContextTool.js";
import { CodeSearchRepairTool } from "../../CodeSearchRepairTool/CodeSearchRepairTool.js";
import { CodeSearchTool } from "../CodeSearchTool.js";
import type { ToolCallContext } from "../../../types.js";

describe("code search tools", () => {
  let root: string;
  let context: ToolCallContext;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-code-search-tool-"));
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    await fsp.writeFile(path.join(root, "src", "alpha.ts"), "export function alphaValue() { return 1; }\n");
    context = {
      cwd: root,
      goalId: "goal-1",
      trustBalance: 0,
      preApproved: true,
      approvalFn: async () => true,
    };
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("code_search and code_read_context provide structured context", async () => {
    const search = await new CodeSearchTool().call({ task: "find alphaValue", intent: "explain" }, context);
    expect(search.success).toBe(true);
    const candidates = (search.data as { candidates: Parameters<CodeReadContextTool["call"]>[0]["candidates"] }).candidates;
    expect(candidates.length).toBeGreaterThan(0);

    const read = await new CodeReadContextTool().call({ candidates, phase: "locate", maxReadRanges: 1 }, context);
    expect(read.success).toBe(true);
    expect(JSON.stringify(read.data)).toContain("alphaValue");
  });

  it("code_search_repair parses verification output and suggests candidates", async () => {
    const result = await new CodeSearchRepairTool().call({
      priorTask: { task: "fix alphaValue", intent: "bugfix" },
      verificationOutput: "ReferenceError: alphaValue is not defined\n    at src/alpha.ts:1:1",
    }, context);

    expect(result.success).toBe(true);
    expect((result.data as { signal: { kind: string }; candidates: unknown[] }).signal.kind).toBe("undefined_symbol");
    expect((result.data as { candidates: unknown[] }).candidates.length).toBeGreaterThan(0);
  });
});
