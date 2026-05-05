import { describe, expect, it } from "vitest";
import { recognizeRuntimeControlIntent } from "../runtime-control-intent.js";
import { RuntimeControlOperationKindSchema } from "../../store/runtime-operation-schemas.js";
import { createSingleMockLLMClient } from "../../../../tests/helpers/mock-llm.js";

describe("recognizeRuntimeControlIntent", () => {
  it("returns null without an LLM classifier", async () => {
    await expect(recognizeRuntimeControlIntent("この実行を一時停止して")).resolves.toBeNull();
  });

  it("uses the LLM decision for daemon and gateway restart operations", async () => {
    await expect(recognizeRuntimeControlIntent(
      "gateway を再起動して",
      createSingleMockLLMClient(JSON.stringify({ intent: "restart_gateway", reason: "restart gateway" }))
    )).resolves.toMatchObject({ kind: "restart_gateway" });

    await expect(recognizeRuntimeControlIntent(
      "PulSeed を再起動して",
      createSingleMockLLMClient(JSON.stringify({ intent: "restart_daemon", reason: "restart daemon" }))
    )).resolves.toMatchObject({ kind: "restart_daemon" });
  });

  it("keeps classifier operation decisions aligned with the runtime operation schema", async () => {
    for (const operation of RuntimeControlOperationKindSchema.options) {
      const llm = createSingleMockLLMClient(JSON.stringify({
        intent: operation,
        reason: `classify ${operation}`,
      }));
      await expect(recognizeRuntimeControlIntent(`classify ${operation}`, llm)).resolves.toMatchObject({
        kind: operation,
      });
    }
  });

  it("uses the LLM decision for natural-language run inspection", async () => {
    const llm = createSingleMockLLMClient(JSON.stringify({
      intent: "inspect_run",
      reason: "inspect current execution",
    }));

    await expect(recognizeRuntimeControlIntent("この実行の状況を見て", llm)).resolves.toMatchObject({
      kind: "inspect_run",
    });
  });

  it("uses the LLM decision for natural-language run pause", async () => {
    const llm = createSingleMockLLMClient(JSON.stringify({
      intent: "pause_run",
      reason: "pause named run",
      target: { runId: "run:coreloop:abc" },
    }));

    await expect(recognizeRuntimeControlIntent("pause run:coreloop:abc", llm)).resolves.toMatchObject({
      kind: "pause_run",
      target: { runId: "run:coreloop:abc" },
    });
  });

  it("uses the LLM decision for natural-language run resume and continuation", async () => {
    const llm = createSingleMockLLMClient(JSON.stringify({
      intent: "resume_run",
      reason: "resume this execution",
    }));

    await expect(recognizeRuntimeControlIntent("この実行を続けて", llm)).resolves.toMatchObject({
      kind: "resume_run",
    });
  });

  it("preserves typed natural-language target selectors for caller-path resolution", async () => {
    const llm = createSingleMockLLMClient(JSON.stringify({
      intent: "pause_run",
      reason: "pause current run",
      targetSelector: { scope: "run", reference: "current", sourceText: "この実行" },
    }));

    await expect(recognizeRuntimeControlIntent("この実行を止めて", llm)).resolves.toMatchObject({
      kind: "pause_run",
      targetSelector: { scope: "run", reference: "current", sourceText: "この実行" },
    });
  });

  it("uses the LLM decision for finalization and external action flags", async () => {
    const llm = createSingleMockLLMClient(JSON.stringify({
      intent: "finalize_run",
      reason: "finalize run but no external submission",
      irreversible: true,
      externalActions: ["submit"],
    }));

    await expect(recognizeRuntimeControlIntent(
      "Finalize with the best candidate but do not submit externally",
      llm
    )).resolves.toMatchObject({
      kind: "finalize_run",
      irreversible: true,
      externalActions: ["submit"],
    });
  });

  it("uses the LLM decision to leave progress questions for evidence Q&A", async () => {
    const llm = createSingleMockLLMClient(JSON.stringify({
      intent: "none",
      reason: "progress question",
    }));

    await expect(recognizeRuntimeControlIntent("進捗は？", llm)).resolves.toBeNull();
  });

  it("uses the LLM decision to leave ordinary continuation on chat routes", async () => {
    const llm = createSingleMockLLMClient(JSON.stringify({
      intent: "none",
      reason: "ordinary implementation continuation",
    }));

    await expect(recognizeRuntimeControlIntent("finish the implementation", llm)).resolves.toBeNull();
  });
});
