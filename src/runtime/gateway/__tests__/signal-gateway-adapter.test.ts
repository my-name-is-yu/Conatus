import { describe, expect, it } from "vitest";
import { SignalGatewayAdapter, type SignalGatewayConfig } from "../signal-gateway-adapter.js";

function makeConfig(): SignalGatewayConfig {
  return {
    bridge_url: "http://localhost:8080",
    account: "+10000000000",
    recipient_id: "+10000000001",
    identity_key: "signal:user",
    allowed_sender_ids: [],
    denied_sender_ids: [],
    allowed_conversation_ids: [],
    denied_conversation_ids: [],
    runtime_control_allowed_sender_ids: [],
    conversation_goal_map: {},
    sender_goal_map: {},
    poll_interval_ms: 5000,
    receive_timeout_ms: 2000,
  };
}

describe("SignalGatewayAdapter", () => {
  it("does not include token-only message text in fallback message ids", () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const adapter = new SignalGatewayAdapter(makeConfig());
    const normalized = (adapter as unknown as {
      normalizeMessage(message: unknown): { messageId: string } | null;
    }).normalizeMessage({
      sender: "+10000000002",
      timestamp: 123456,
      message: token,
    });

    expect(normalized?.messageId).not.toContain(token);
    expect(normalized?.messageId).toContain("+10000000002:123456:");
  });
});
