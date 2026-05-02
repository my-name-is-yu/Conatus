import * as fsp from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import { KnowledgeManager } from "../knowledge-manager.js";

describe("KnowledgeManager memory quarantine", () => {
  let tmpDir: string;
  let manager: KnowledgeManager;

  beforeEach(async () => {
    tmpDir = makeTempDir("pulseed-memory-quarantine-");
    const stateManager = new StateManager(tmpDir);
    await stateManager.init();
    manager = new KnowledgeManager(stateManager, {} as ILLMClient);
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("keeps quarantined memory inspectable but out of default recall", async () => {
    const entry = await manager.saveAgentMemory({
      key: "unsupported-claim",
      value: "Unverified claim.",
      memory_type: "fact",
    });

    const count = await manager.quarantineAgentMemory({
      targetIds: [entry.id],
      reason: "Missing provenance for planning use.",
      source: "memory_lint",
      confidence: 0.82,
      inspectionRefs: [`agent_memory:${entry.id}`],
      createdAt: "2026-05-02T00:00:00.000Z",
    });

    expect(count).toBe(1);
    expect(await manager.recallAgentMemory("unsupported-claim", { exact: true })).toEqual([]);
    expect(await manager.recallAgentMemory("unsupported-claim", { exact: true, include_archived: true })).toEqual([
      expect.objectContaining({
        id: entry.id,
        status: "quarantined",
        quarantine_state: expect.objectContaining({
          reason: "Missing provenance for planning use.",
          active: false,
        }),
      }),
    ]);
  });
});
