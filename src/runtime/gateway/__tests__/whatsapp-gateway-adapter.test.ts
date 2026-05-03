import { describe, expect, it } from "vitest";
import { WhatsAppGatewayAdapter, type WhatsAppGatewayConfig } from "../whatsapp-gateway-adapter.js";

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
