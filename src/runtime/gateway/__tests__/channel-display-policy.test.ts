import { describe, expect, it } from "vitest";
import {
  DISCORD_GATEWAY_DISPLAY_CONTRACT,
  LIMITED_GATEWAY_DISPLAY_CAPABILITIES,
  SIGNAL_GATEWAY_DISPLAY_CONTRACT,
  SLACK_GATEWAY_DISPLAY_CONTRACT,
  TELEGRAM_GATEWAY_DISPLAY_CONTRACT,
  WHATSAPP_GATEWAY_DISPLAY_CONTRACT,
  createGatewayDisplayPolicy,
  resolveGatewayChannelDisplayContract,
} from "../channel-display-policy.js";

describe("gateway channel display policy", () => {
  it("resolves editable channel defaults to a temporary progress surface and streamed final surface", () => {
    const telegram = resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT);

    expect(telegram.policy).toMatchObject({
      progressSurface: "editable",
      finalSurface: "edit_stream",
      cleanupPolicy: "delete",
      toolProgress: "all",
      showReasoning: false,
    });
    expect(telegram.capabilities.maxMessageLength).toBe(4_096);
  });

  it("keeps transport capability separate from display policy overrides", () => {
    const policy = createGatewayDisplayPolicy(DISCORD_GATEWAY_DISPLAY_CONTRACT.capabilities, {
      cleanupPolicy: "collapse",
      toolProgress: "new",
      progressMaxItems: 3,
    });

    expect(DISCORD_GATEWAY_DISPLAY_CONTRACT.capabilities.canDeleteMessages).toBe(true);
    expect(policy).toMatchObject({
      progressSurface: "editable",
      finalSurface: "edit_stream",
      cleanupPolicy: "collapse",
      toolProgress: "new",
      progressMaxItems: 3,
      showReasoning: false,
    });
  });

  it("defaults limited channels to no progress fanout with final chunking when limits are known", () => {
    const signal = resolveGatewayChannelDisplayContract(SIGNAL_GATEWAY_DISPLAY_CONTRACT);
    const whatsapp = resolveGatewayChannelDisplayContract(WHATSAPP_GATEWAY_DISPLAY_CONTRACT);

    expect(signal.policy).toMatchObject({
      progressSurface: "off",
      finalSurface: "chunked",
      cleanupPolicy: "none",
      toolProgress: "off",
      showReasoning: false,
    });
    expect(whatsapp.policy).toMatchObject({
      progressSurface: "off",
      finalSurface: "chunked",
      cleanupPolicy: "none",
      toolProgress: "off",
      showReasoning: false,
    });
  });

  it("falls back to send-once final delivery when no adapter contract is declared", () => {
    const resolved = resolveGatewayChannelDisplayContract(undefined);

    expect(resolved.capabilities).toBe(LIMITED_GATEWAY_DISPLAY_CAPABILITIES);
    expect(resolved.policy).toMatchObject({
      progressSurface: "off",
      finalSurface: "send_once",
      cleanupPolicy: "none",
      toolProgress: "off",
      showReasoning: false,
    });
  });

  it("declares Slack as editable while keeping policy derivation typed", () => {
    const slack = resolveGatewayChannelDisplayContract(SLACK_GATEWAY_DISPLAY_CONTRACT);

    expect(slack.capabilities).toMatchObject({
      canEditMessages: true,
      canDeleteMessages: true,
      canThreadReplies: true,
      canSendReactions: true,
    });
    expect(slack.policy.progressSurface).toBe("editable");
  });
});
