import * as fsp from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import { KnowledgeManager } from "../knowledge-manager.js";

describe("KnowledgeManager memory governance", () => {
  let tmpDir: string;
  let manager: KnowledgeManager;

  beforeEach(async () => {
    tmpDir = makeTempDir("pulseed-memory-governance-");
    const stateManager = new StateManager(tmpDir);
    await stateManager.init();
    manager = new KnowledgeManager(stateManager, {} as ILLMClient);
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("filters retrieval by consent scope and sensitivity", async () => {
    await manager.saveAgentMemory({
      key: "public-note",
      value: "Useful local note.",
      governance: {
        sensitivity: "local",
        consent: {
          scope_id: "local_planning",
          allowed_contexts: ["local_planning"],
          source_actor: "user",
          collection_context: "memory_save",
        },
        retention: {
          policy_id: "retain_until_retracted",
          retain_until: null,
          review_after: null,
          delete_requires_approval: true,
        },
        export_visibility: "listed",
        owner_ref: "user",
      },
    });
    await manager.saveAgentMemory({
      key: "secret-note",
      value: "Secret value.",
      governance: {
        sensitivity: "secret",
        consent: {
          scope_id: "private_chat",
          allowed_contexts: ["private_chat"],
          source_actor: "user",
          collection_context: "chat",
        },
        retention: {
          policy_id: "retain_until_retracted",
          retain_until: null,
          review_after: null,
          delete_requires_approval: true,
        },
        export_visibility: "listed",
        owner_ref: "user",
      },
    });

    expect((await manager.listAgentMemory({
      consent_scope: "local_planning",
      max_sensitivity: "local",
      limit: 10,
    })).map((entry) => entry.key)).toEqual(["public-note"]);
  });

  it("exports governance metadata while hiding secret memories by default", async () => {
    await manager.saveAgentMemory({ key: "local-note", value: "Local", governance: { sensitivity: "local" } });
    await manager.saveAgentMemory({ key: "secret-note", value: "Secret", governance: { sensitivity: "secret" } });

    const visible = await manager.exportAgentMemoryGovernance();
    const withSecret = await manager.exportAgentMemoryGovernance({ include_secret: true });

    expect(visible.map((entry) => entry.key)).toEqual(["local-note"]);
    expect(withSecret.map((entry) => entry.key).sort()).toEqual(["local-note", "secret-note"]);
    expect(withSecret[0]!.governance).toHaveProperty("retention");
    expect(withSecret[0]!.governance).toHaveProperty("consent");
  });
});
