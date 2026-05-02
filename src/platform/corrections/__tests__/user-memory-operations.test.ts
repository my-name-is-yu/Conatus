import * as fsp from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import { KnowledgeManager } from "../../knowledge/knowledge-manager.js";
import { AGENT_MEMORY_PATH } from "../../knowledge/knowledge-manager-internals.js";
import type { AgentMemoryEntry } from "../../knowledge/types/agent-memory.js";
import { runUserMemoryOperation } from "../user-memory-operations.js";

function memoryEntry(overrides: Partial<AgentMemoryEntry> = {}): AgentMemoryEntry {
  return {
    id: "memory-old",
    key: "favorite-editor",
    value: "The user prefers Atom.",
    tags: ["preference"],
    memory_type: "preference",
    status: "raw",
    created_at: "2026-05-02T00:00:00.000Z",
    updated_at: "2026-05-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("user memory correction operations", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tmpDir = makeTempDir("pulseed-user-memory-ops-");
    stateManager = new StateManager(tmpDir);
    await stateManager.init();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("records a user correction event and keeps stale agent memory out of default recall", async () => {
    await stateManager.writeRaw(AGENT_MEMORY_PATH, {
      entries: [memoryEntry()],
      corrections: [],
      last_consolidated_at: null,
    });

    const result = await runUserMemoryOperation(stateManager, {
      operation: "correct",
      targetRef: { kind: "agent_memory", id: "memory-old" },
      reason: "User corrected their editor preference.",
      replacementValue: "The user prefers VS Code.",
      replacementKey: "favorite-editor-current",
      now: "2026-05-02T01:00:00.000Z",
    });

    expect(result.correction).toMatchObject({
      target_ref: { kind: "agent_memory", id: "memory-old" },
      correction_kind: "corrected",
      actor: "user",
    });
    expect(result.replacement?.ref.kind).toBe("agent_memory");

    const manager = new KnowledgeManager(stateManager, {} as ILLMClient);
    expect(await manager.recallAgentMemory("favorite-editor", { exact: true })).toEqual([]);
    expect(await manager.recallAgentMemory("favorite-editor-current", { exact: true })).toEqual([
      expect.objectContaining({
        key: "favorite-editor-current",
        value: "The user prefers VS Code.",
        supersedes_memory_id: "memory-old",
      }),
    ]);

    const store = await manager.loadAgentMemoryStore();
    expect(store.entries.find((entry) => entry.id === "memory-old")).toMatchObject({
      status: "corrected",
      correction_state: { status: "corrected", active: false, retained_for_audit: true },
    });
    expect(store.corrections).toHaveLength(1);
  });
});
