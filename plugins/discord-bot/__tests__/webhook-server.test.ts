import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordWebhookServer } from "../src/webhook-server.js";
import type { DiscordBotConfig } from "../src/config.js";
import type { DiscordAPI } from "../src/discord-api.js";
import { createJsonPostRequest, createMockServerResponse } from "../../../tests/helpers/http-mocks.js";

describe("DiscordWebhookServer", () => {
  const config: DiscordBotConfig = {
    application_id: "app-1",
    bot_token: "Bot token",
    channel_id: "channel-1",
    identity_key: "discord:ops",
    runtime_control_allowed_sender_ids: ["user-1"],
    command_name: "pulseed",
    host: "127.0.0.1",
    port: 8787,
    ephemeral: false,
  };

  let api: Pick<DiscordAPI, "sendInteractionFollowUp">;

  beforeEach(() => {
    api = {
      sendInteractionFollowUp: vi.fn().mockResolvedValue(undefined),
    };
  });

  it("marks runtime control approved for configured Discord sender ids", async () => {
    const fetchChatReply = vi.fn().mockResolvedValue("ok");
    const server = new DiscordWebhookServer(config, api as DiscordAPI, fetchChatReply);
    const { res, done } = createMockServerResponse();

    await server.handleRequest(
      createJsonPostRequest({
        id: "interaction-1",
        type: 2,
        token: "token-1",
        application_id: "app-1",
        channel_id: "channel-1",
        member: { user: { id: "user-1" } },
        data: { name: "pulseed", options: [{ name: "message", value: "PulSeed を再起動して" }] },
      }),
      res
    );
    await done;

    await vi.waitFor(() => {
      expect(fetchChatReply).toHaveBeenCalledWith(
        expect.objectContaining({
          sender_id: "user-1",
          metadata: expect.objectContaining({ runtime_control_approved: true }),
        })
      );
    });
  });

  it("does not approve runtime control for unconfigured Discord sender ids", async () => {
    const fetchChatReply = vi.fn().mockResolvedValue("ok");
    const server = new DiscordWebhookServer(config, api as DiscordAPI, fetchChatReply);
    const { res, done } = createMockServerResponse();

    await server.handleRequest(
      createJsonPostRequest({
        id: "interaction-2",
        type: 2,
        token: "token-2",
        application_id: "app-1",
        channel_id: "channel-1",
        member: { user: { id: "user-2" } },
        data: { name: "pulseed", options: [{ name: "message", value: "PulSeed を再起動して" }] },
      }),
      res
    );
    await done;

    await vi.waitFor(() => {
      expect(fetchChatReply).toHaveBeenCalledWith(
        expect.objectContaining({
          sender_id: "user-2",
          metadata: expect.not.objectContaining({ runtime_control_approved: true }),
        })
      );
    });
  });
});
