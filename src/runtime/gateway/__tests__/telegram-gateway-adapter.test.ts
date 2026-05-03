import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchGatewayChatInput } from "../chat-session-dispatch.js";
import { TelegramGatewayAdapter } from "../telegram-gateway-adapter.js";

vi.mock("../chat-session-dispatch.js", () => ({
  dispatchGatewayChatInput: vi.fn().mockResolvedValue("ok"),
}));

const tempDirs: string[] = [];
const adapters: TelegramGatewayAdapter[] = [];

beforeEach(() => {
  vi.mocked(dispatchGatewayChatInput).mockReset();
  vi.mocked(dispatchGatewayChatInput).mockResolvedValue("ok");
});

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stop()));
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("TelegramGatewayAdapter", () => {
  it("passes the Telegram message id from polling updates into gateway chat dispatch", async () => {
    const configDir = await writeConfig({
      bot_token: "test-token",
      allowed_user_ids: [42],
      denied_user_ids: [],
      allowed_chat_ids: [],
      denied_chat_ids: [],
      runtime_control_allowed_user_ids: [42],
      chat_goal_map: {},
      user_goal_map: {},
      allow_all: true,
      polling_timeout: 30,
      identity_key: "seedy",
    });
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const method = String(url).split("/").at(-1);
      if (method === "getMe") {
        return telegramResponse({ id: 1, username: "pulseed_test_bot" });
      }
      if (method === "getUpdates") {
        return telegramResponse([
          {
            update_id: 100,
            message: {
              message_id: 2718,
              from: { id: 42 },
              chat: { id: 314 },
              text: "hello",
            },
          },
        ]);
      }
      if (method === "sendMessage") {
        return telegramResponse({ message_id: 9001 });
      }
      throw new Error(`unexpected Telegram method: ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = TelegramGatewayAdapter.fromConfigDir(configDir);
    adapters.push(adapter);
    vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async () => {
      await adapter.stop();
      return "ok";
    });

    await adapter.start();

    await vi.waitFor(() => {
      expect(dispatchGatewayChatInput).toHaveBeenCalledWith(expect.objectContaining({
        text: "hello",
        platform: "telegram",
        identity_key: "seedy",
        conversation_id: "314",
        sender_id: "42",
        message_id: "2718",
        metadata: expect.objectContaining({
          chat_id: 314,
          runtime_control_approved: true,
        }),
      }));
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottest-token/getUpdates",
      expect.objectContaining({
        body: JSON.stringify({
          offset: 0,
          timeout: 30,
          allowed_updates: ["message"],
        }),
      })
    );
  });

  it("renders operation progress events before the final Telegram reply", async () => {
    const configDir = await writeConfig({
      bot_token: "test-token",
      allowed_user_ids: [42],
      denied_user_ids: [],
      allowed_chat_ids: [],
      denied_chat_ids: [],
      runtime_control_allowed_user_ids: [42],
      chat_goal_map: {},
      user_goal_map: {},
      allow_all: true,
      polling_timeout: 30,
      identity_key: "seedy",
    });
    const sentMessages: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      if (method === "getMe") {
        return telegramResponse({ id: 1, username: "pulseed_test_bot" });
      }
      if (method === "getUpdates") {
        return telegramResponse([
          {
            update_id: 100,
            message: {
              message_id: 2718,
              from: { id: 42 },
              chat: { id: 314 },
              text: "telegram setup",
            },
          },
        ]);
      }
      if (method === "sendMessage") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
        sentMessages.push(body.text ?? "");
        return telegramResponse({ message_id: 9000 + sentMessages.length });
      }
      if (method === "editMessageText") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
        sentMessages.push(body.text ?? "");
        return telegramResponse({ message_id: 9100 + sentMessages.length });
      }
      throw new Error(`unexpected Telegram method: ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = TelegramGatewayAdapter.fromConfigDir(configDir);
    adapters.push(adapter);
    vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
      await input.onEvent?.({
        type: "lifecycle_start",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: "2026-04-08T00:00:00.000Z",
        input: "telegram setup",
      });
      await input.onEvent?.({
        type: "operation_progress",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: "2026-04-08T00:00:01.000Z",
        item: {
          id: "telegram-configure:read-config",
          kind: "read_config",
          operation: "telegram_setup",
          title: "Read Telegram config",
          detail: "Config file does not exist yet.",
          createdAt: "2026-04-08T00:00:01.000Z",
        },
      });
      await input.onEvent?.({
        type: "assistant_final",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: "2026-04-08T00:00:02.000Z",
        text: "Final setup guidance.",
        persisted: true,
      });
      await adapter.stop();
      return "Final setup guidance.";
    });

    await adapter.start();

    await vi.waitFor(() => {
      expect(sentMessages).toContain("Read Telegram config: Config file does not exist yet.");
      expect(sentMessages).toContain("Final setup guidance.");
    });
    expect(sentMessages.filter((message) => message === "Final setup guidance.")).toHaveLength(1);
  });

  it("does not send fallback while async assistant_final delivery is still draining", async () => {
    const configDir = await writeConfig({
      bot_token: "test-token",
      allowed_user_ids: [42],
      denied_user_ids: [],
      allowed_chat_ids: [],
      denied_chat_ids: [],
      runtime_control_allowed_user_ids: [42],
      chat_goal_map: {},
      user_goal_map: {},
      allow_all: true,
      polling_timeout: 30,
      identity_key: "seedy",
    });
    const finalSendStarted = createDeferred();
    const finalSendCanFinish = createDeferred();
    const sentMessages: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      if (method === "getMe") {
        return telegramResponse({ id: 1, username: "pulseed_test_bot" });
      }
      if (method === "getUpdates") {
        return telegramResponse([
          {
            update_id: 100,
            message: {
              message_id: 2718,
              from: { id: 42 },
              chat: { id: 314 },
              text: "hello",
            },
          },
        ]);
      }
      if (method === "sendMessage") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
        sentMessages.push(body.text ?? "");
        if (body.text === "Final setup guidance.") {
          finalSendStarted.resolve();
          await finalSendCanFinish.promise;
        }
        return telegramResponse({ message_id: 9000 + sentMessages.length });
      }
      throw new Error(`unexpected Telegram method: ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = TelegramGatewayAdapter.fromConfigDir(configDir);
    adapters.push(adapter);
    vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
      await input.onEvent?.({
        type: "assistant_final",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: "2026-04-08T00:00:02.000Z",
        text: "Final setup guidance.",
        persisted: true,
      });
      await adapter.stop();
      return "Final setup guidance.";
    });

    await adapter.start();
    await finalSendStarted.promise;
    expect(sentMessages.filter((message) => message === "Final setup guidance.")).toHaveLength(1);
    finalSendCanFinish.resolve();

    await vi.waitFor(() => {
      expect(sentMessages.filter((message) => message === "Final setup guidance.")).toHaveLength(1);
    });
  });
});

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function writeConfig(config: Record<string, unknown>): Promise<string> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-telegram-gateway-"));
  tempDirs.push(configDir);
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify(config), "utf-8");
  return configDir;
}

function telegramResponse(result: unknown): Response {
  return {
    ok: true,
    json: async () => ({ ok: true, result }),
  } as Response;
}
