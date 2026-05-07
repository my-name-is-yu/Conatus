import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchGatewayChatInput } from "../chat-session-dispatch.js";
import { WhatsAppGatewayAdapter, type WhatsAppGatewayConfig } from "../whatsapp-gateway-adapter.js";

vi.mock("../chat-session-dispatch.js", () => ({
  dispatchGatewayChatInput: vi.fn().mockResolvedValue("WhatsApp reply"),
}));

beforeEach(() => {
  vi.mocked(dispatchGatewayChatInput).mockReset();
  vi.mocked(dispatchGatewayChatInput).mockResolvedValue("WhatsApp reply");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WhatsAppGatewayAdapter", () => {
  it("exposes explicit unsupported typing capability", async () => {
    const adapter = new WhatsAppGatewayAdapter(makeConfig());
    const session = await adapter.typingIndicator.start({
      platform: "whatsapp",
      conversation_id: "15551234567",
    });

    expect(adapter.typingIndicator.status).toBe("unsupported");
    expect(adapter.typingIndicator.reason).toContain("no native typing endpoint");
    expect(session.status).toBe("unsupported");
  });

  it("uses limited display fallback without progress fanout and chunks final output", async () => {
    const sentBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: { body?: string } };
      sentBodies.push(body.text?.body ?? "");
      return okResponse({});
    }));
    vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
      await input.onEvent?.({ ...eventBase, type: "activity", kind: "tool", message: "Running noisy tool" });
      await input.onEvent?.({
        ...eventBase,
        type: "tool_start",
        toolCallId: "tool-1",
        toolName: "rg",
        args: {},
      });
      await input.onEvent?.({
        ...eventBase,
        type: "assistant_final",
        text: `${"a".repeat(4_096)}b`,
        persisted: true,
      });
      return "fallback should not send";
    });
    const adapter = new WhatsAppGatewayAdapter({
      ...makeConfig(),
      recipient_id: "15551234567",
    });

    await (adapter as unknown as {
      processMessage(message: { id: string; from: string; text: { body: string }; type: string }): Promise<void>;
    }).processMessage({
      id: "wamid-1",
      from: "15557654321",
      type: "text",
      text: { body: "hello" },
    });

    expect(sentBodies).toEqual(["a".repeat(4_096), "b"]);
  });
});

function makeConfig(): WhatsAppGatewayConfig {
  return {
    phone_number_id: "phone-1",
    access_token: "token-1",
    verify_token: "verify-1",
    recipient_id: "15551234567",
    identity_key: "whatsapp:user",
    allowed_sender_ids: [],
    denied_sender_ids: [],
    runtime_control_allowed_sender_ids: [],
    sender_goal_map: {},
    host: "127.0.0.1",
    port: 8788,
    path: "/webhook",
  };
}

const eventBase = {
  runId: "run-1",
  turnId: "turn-1",
  createdAt: "2026-05-07T00:00:00.000Z",
};

function okResponse(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}
