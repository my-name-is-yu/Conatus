import * as fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { StateManager } from "../../../../base/state/state-manager.js";
import { RuntimeEvidenceLedger } from "../../../../runtime/store/evidence-ledger.js";
import type { ToolCallContext } from "../../../types.js";
import { MemoryCorrectionTool } from "../MemoryCorrectionTool.js";

const context: ToolCallContext = {
  cwd: "/tmp",
  goalId: "goal-memory",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
  sessionId: "session-memory",
};

describe("MemoryCorrectionTool", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tmpDir = makeTempDir("pulseed-memory-correction-tool-");
    stateManager = new StateManager(tmpDir);
    await stateManager.init();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns structured refs and retracts runtime evidence from default summaries", async () => {
    const ledger = new RuntimeEvidenceLedger(path.join(tmpDir, "runtime"));
    await ledger.append({
      id: "evidence-stale",
      occurred_at: "2026-05-02T00:00:00.000Z",
      kind: "observation",
      scope: { goal_id: "goal-memory", run_id: "run:memory" },
      summary: "Stale evidence that should not plan.",
      outcome: "continued",
    });

    const tool = new MemoryCorrectionTool(stateManager);
    const result = await tool.call({
      operation: "retract",
      target_ref: "runtime_evidence:evidence-stale",
      reason: "User identified the evidence as incorrect.",
      goal_id: "goal-memory",
      run_id: "run:memory",
    }, context);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      operation: "retract",
      target_ref: {
        kind: "runtime_evidence",
        id: "evidence-stale",
        scope: { goal_id: "goal-memory", run_id: "run:memory" },
      },
      correction: {
        correction_kind: "retracted",
        target_ref: {
          kind: "runtime_evidence",
          id: "evidence-stale",
          scope: { goal_id: "goal-memory", run_id: "run:memory" },
        },
      },
    });

    const summary = await new RuntimeEvidenceLedger(path.join(tmpDir, "runtime")).summarizeRun("run:memory");
    expect(summary.corrections).toHaveLength(1);
    expect(summary.recent_entries.map((entry) => entry.id)).not.toContain("evidence-stale");
  });

  it("keeps runtime evidence history scoped when ids repeat across runs", async () => {
    const ledger = new RuntimeEvidenceLedger(path.join(tmpDir, "runtime"));
    await ledger.append({
      id: "evidence-shared",
      occurred_at: "2026-05-02T00:00:00.000Z",
      kind: "observation",
      scope: { goal_id: "goal-memory", run_id: "run:a" },
      summary: "Stale evidence in run A.",
      outcome: "continued",
    });
    await ledger.append({
      id: "evidence-shared",
      occurred_at: "2026-05-02T00:00:00.000Z",
      kind: "observation",
      scope: { goal_id: "goal-memory", run_id: "run:b" },
      summary: "Stale evidence in run B.",
      outcome: "continued",
    });

    const tool = new MemoryCorrectionTool(stateManager);
    await tool.call({
      operation: "retract",
      target_ref: "runtime_evidence:evidence-shared",
      reason: "Run A evidence was incorrect.",
      goal_id: "goal-memory",
      run_id: "run:a",
    }, context);
    await tool.call({
      operation: "retract",
      target_ref: "runtime_evidence:evidence-shared",
      reason: "Run B evidence was incorrect.",
      goal_id: "goal-memory",
      run_id: "run:b",
    }, context);

    const result = await tool.call({
      operation: "history",
      target_ref: "runtime_evidence:evidence-shared",
      goal_id: "goal-memory",
      run_id: "run:a",
    }, context);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      history: [
        expect.objectContaining({
          reason: "Run A evidence was incorrect.",
          target_ref: {
            kind: "runtime_evidence",
            id: "evidence-shared",
            scope: { goal_id: "goal-memory", run_id: "run:a" },
          },
        }),
      ],
    });
    expect(JSON.stringify(result.data)).not.toContain("Run B evidence was incorrect.");
  });
});
