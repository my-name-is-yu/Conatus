import { describe, expect, it } from "vitest";
import {
  AgentMemoryEntrySchema,
} from "../../knowledge/types/agent-memory.js";
import {
  correctionStateForTarget,
  memoryCorrectionTargetKey,
  MemoryCorrectionEntrySchema,
  summarizeMemoryCorrectionState,
} from "../memory-correction-ledger.js";

describe("memory correction ledger", () => {
  it("marks an agent memory as corrected while preserving the original entry for audit", () => {
    const original = AgentMemoryEntrySchema.parse({
      id: "memory-old",
      key: "user.preference.editor",
      value: "User prefers Vim.",
      status: "compiled",
      created_at: "2026-05-02T00:00:00.000Z",
      updated_at: "2026-05-02T00:00:00.000Z",
    });
    const replacement = AgentMemoryEntrySchema.parse({
      id: "memory-new",
      key: "user.preference.editor",
      value: "User prefers VS Code.",
      status: "compiled",
      supersedes_memory_id: original.id,
      created_at: "2026-05-02T00:01:00.000Z",
      updated_at: "2026-05-02T00:01:00.000Z",
    });
    const correction = MemoryCorrectionEntrySchema.parse({
      correction_id: "corr-agent-memory",
      target_ref: { kind: "agent_memory", id: original.id },
      correction_kind: "corrected",
      replacement_ref: { kind: "agent_memory", id: replacement.id },
      actor: "user",
      reason: "User corrected the stored editor preference.",
      created_at: "2026-05-02T00:02:00.000Z",
      provenance: { source: "user", confidence: 1 },
    });

    const state = correctionStateForTarget(
      summarizeMemoryCorrectionState([correction]),
      { kind: "agent_memory", id: original.id }
    );

    expect(original.value).toBe("User prefers Vim.");
    expect(replacement.supersedes_memory_id).toBe(original.id);
    expect(state).toMatchObject({
      status: "corrected",
      active: false,
      latest_correction_id: "corr-agent-memory",
      retained_for_audit: true,
      replacement_ref: { kind: "agent_memory", id: replacement.id },
    });
  });

  it("keeps scoped runtime targets distinct when ids are reused across runs", () => {
    const runA = { kind: "runtime_evidence" as const, id: "entry-1", scope: { run_id: "run-a" } };
    const runB = { kind: "runtime_evidence" as const, id: "entry-1", scope: { run_id: "run-b" } };

    expect(memoryCorrectionTargetKey(runA)).toBe(JSON.stringify(["runtime_evidence", "entry-1", null, "run-a", null]));
    expect(memoryCorrectionTargetKey(runB)).toBe(JSON.stringify(["runtime_evidence", "entry-1", null, "run-b", null]));
    expect(memoryCorrectionTargetKey(runA)).not.toBe(memoryCorrectionTargetKey(runB));
  });

  it("does not collide when ids contain scope-like delimiters", () => {
    const unscoped = { kind: "runtime_evidence" as const, id: "entry-1:run=run-a" };
    const scoped = { kind: "runtime_evidence" as const, id: "entry-1", scope: { run_id: "run-a" } };

    expect(memoryCorrectionTargetKey(unscoped)).not.toBe(memoryCorrectionTargetKey(scoped));
  });
});
