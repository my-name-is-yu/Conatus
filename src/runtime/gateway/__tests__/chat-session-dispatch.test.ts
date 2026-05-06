import { afterEach, describe, expect, it } from "vitest";
import { dispatchGatewayChatInput } from "../chat-session-dispatch.js";
import { renderGatewayAgentTimelineItem } from "../chat-event-rendering.js";
import {
  clearRegisteredGatewayChatSessionPort,
  registerGatewayChatSessionPort,
} from "../chat-session-port.js";

const baseInput = {
  text: "status?",
  platform: "telegram",
  conversation_id: "chat-1",
  sender_id: "user-1",
};

afterEach(() => {
  clearRegisteredGatewayChatSessionPort();
});

describe("dispatchGatewayChatInput display contract", () => {
  it("projects answer-shaped fallback strings to gateway display text", async () => {
    registerGatewayChatSessionPort(async () => ({
      processIncomingMessage: async () => JSON.stringify({
        answer: "Gateway **Markdown** answer.",
      }),
    }));

    const result = await dispatchGatewayChatInput(baseInput);

    expect(result).toBe("Gateway **Markdown** answer.");
    expect(result).not.toContain("\"answer\"");
  });

  it("preserves plain text fallback objects from gateway session ports", async () => {
    registerGatewayChatSessionPort(async () => ({
      processIncomingMessage: async () => ({ text: "Plain gateway reply." }),
    }));

    await expect(dispatchGatewayChatInput(baseInput)).resolves.toBe("Plain gateway reply.");
  });

  it("formats structured fallback objects without exposing raw schema payloads", async () => {
    registerGatewayChatSessionPort(async () => ({
      processIncomingMessage: async () => ({
        status: "done",
        message: "",
        finalAnswer: {
          summary: "Runtime evidence is current.",
          sections: [{ title: "Checks", bullets: ["Read the active run record."] }],
          evidence: ["run:active matched the selected session"],
          blockers: [],
          nextActions: ["Continue monitoring the run."],
        },
      }),
    }));

    const result = await dispatchGatewayChatInput(baseInput);

    expect(result).toContain("Runtime evidence is current.");
    expect(result).toContain("### Checks");
    expect(result).toContain("### Evidence");
    expect(result).toContain("### Next steps");
    expect(result).not.toContain("\"finalAnswer\"");
  });

  it("does not invent display text for unwrappable manager objects", async () => {
    registerGatewayChatSessionPort(async () => ({
      processIncomingMessage: async () => ({ internal_payload: { raw: true } }),
    }));

    await expect(dispatchGatewayChatInput(baseInput)).resolves.toBeNull();
  });

  it("renders denied typed tool observations as gateway display text", () => {
    const result = renderGatewayAgentTimelineItem({
      kind: "tool_observation",
      toolName: "apply_patch",
      state: "denied",
      outputPreview: "TOOL NOT EXECUTED (approval_denied): write access was denied.",
    });

    expect(result).toBe("Observed apply_patch (denied): TOOL NOT EXECUTED (approval_denied): write access was denied.");
    expect(result).not.toContain("\"observation\"");
  });
});
