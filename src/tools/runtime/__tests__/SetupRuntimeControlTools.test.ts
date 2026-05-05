import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../../../base/state/state-manager.js";
import { getGatewayChannelDir } from "../../../base/utils/paths.js";
import { intakeSetupSecrets } from "../../../interface/chat/setup-secret-intake.js";
import type { SetupDialogueRuntimeState } from "../../../interface/chat/setup-dialogue.js";
import type { ToolCallContext } from "../../types.js";
import { createSetupRuntimeControlTools } from "../SetupRuntimeControlTools.js";

function makeContext(baseDir: string, overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  let setupDialogue: SetupDialogueRuntimeState | null = null;
  const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
  return {
    cwd: "/repo",
    goalId: "chat",
    trustBalance: 0,
    preApproved: false,
    approvalFn: vi.fn().mockResolvedValue(true),
    providerConfigBaseDir: baseDir,
    setupSecretIntake: intakeSetupSecrets(`telegram token ${token}`),
    setupDialogue: {
      get: () => setupDialogue,
      set: (value) => {
        setupDialogue = value as SetupDialogueRuntimeState | null;
      },
    },
    runtimeControlAllowed: true,
    runtimeControlApprovalMode: "preapproved",
    runtimeControlActor: {
      surface: "gateway",
      platform: "telegram",
      identity_key: "telegram:user-1",
      user_id: "1001",
    },
    runtimeReplyTarget: {
      surface: "gateway",
      channel: "plugin_gateway",
      platform: "telegram",
      conversation_id: "chat-1",
      response_channel: "telegram-chat-1",
      message_id: "message-1",
      metadata: { runtime_control_approved: true },
    },
    ...overrides,
  };
}

describe("setup and runtime-control AgentLoop tools", () => {
  it("prepares Telegram setup guidance from redacted secret intake without exposing the raw token", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-setup-tools-guidance-"));
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    const statusProvider = {
      getTelegramStatus: vi.fn().mockResolvedValue({
        channel: "telegram",
        state: "unconfigured",
        configPath: path.join(baseDir, "gateway/channels/telegram-bot/config.json"),
        daemon: { running: false, port: 41700 },
        gateway: { loadState: "unknown" },
        config: {
          exists: false,
          hasBotToken: false,
          hasHomeChat: false,
          allowAll: false,
          allowedUserCount: 0,
          runtimeControlAllowedUserCount: 0,
          identityKeyConfigured: false,
        },
      }),
    };
    const [, guidanceTool] = createSetupRuntimeControlTools({ stateManager, gatewaySetupStatusProvider: statusProvider });
    const context = makeContext(baseDir);

    const result = await guidanceTool.call({
      channel: "telegram",
      request: "telegramからseedyと会話できるようにしたい",
      language: "ja",
    }, context);

    expect(result.success).toBe(true);
    expect(result.summary).toContain("Telegram gateway status");
    expect(result.summary).not.toContain("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi");
    expect(JSON.stringify(result.data)).not.toContain("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi");
    const pending = await context.setupDialogue!.get() as SetupDialogueRuntimeState;
    expect(pending.publicState).toMatchObject({
      state: "confirm_write",
      selectedChannel: "telegram",
      pendingSecret: { kind: "telegram_bot_token" },
    });
    expect(pending.publicState.pendingSecret?.redaction).toBe("[REDACTED:telegram_bot_token:setup_secret_1]");
    expect(pending.secretValue).toBe("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi");
  });

  it("confirms a pending Telegram config write through approval and requests typed gateway refresh", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-setup-tools-confirm-"));
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    const runtimeControlService = { request: vi.fn().mockResolvedValue({
      success: true,
      message: "gateway refresh requested",
      operationId: "op-refresh",
      state: "verified",
    }) };
    const [, guidanceTool, , confirmTool] = createSetupRuntimeControlTools({
      stateManager,
      gatewaySetupStatusProvider: {
        getTelegramStatus: vi.fn().mockResolvedValue({
          channel: "telegram",
          state: "unconfigured",
          configPath: path.join(baseDir, "gateway/channels/telegram-bot/config.json"),
          daemon: { running: true, port: 41700 },
          gateway: { loadState: "unknown" },
          config: {
            exists: false,
            hasBotToken: false,
            hasHomeChat: false,
            allowAll: false,
            allowedUserCount: 0,
            runtimeControlAllowedUserCount: 0,
            identityKeyConfigured: false,
          },
        }),
      },
      runtimeControlService,
    });
    const context = makeContext(baseDir);
    await guidanceTool.call({ channel: "telegram", request: "telegram setup" }, context);

    const result = await confirmTool.call({ channel: "telegram" }, context);

    expect(result.success).toBe(true);
    expect(result.summary).not.toContain("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi");
    const configPath = path.join(getGatewayChannelDir("telegram-bot", baseDir), "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(config.bot_token).toBe("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi");
    expect(runtimeControlService.request).toHaveBeenCalledWith(expect.objectContaining({
      intent: expect.objectContaining({ kind: "restart_gateway" }),
      requestedBy: expect.objectContaining({ surface: "gateway", identity_key: "telegram:user-1" }),
      replyTarget: expect.objectContaining({
        surface: "gateway",
        response_channel: "telegram-chat-1",
      }),
    }));
  });

  it("requests runtime control through RuntimeControlService with approved metadata", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-tools-approved-"));
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    const runtimeControlService = { request: vi.fn().mockResolvedValue({
      success: true,
      message: "queued restart",
      operationId: "op-1",
      state: "approved",
    }) };
    const requestTool = createSetupRuntimeControlTools({ stateManager, runtimeControlService }).find((tool) => tool.metadata.name === "request_runtime_control")!;
    const context = makeContext(baseDir);

    const result = await requestTool.call({
      operation: "restart_gateway",
      reason: "Apply approved Telegram setup change.",
    }, context);

    expect(result.success).toBe(true);
    expect(runtimeControlService.request).toHaveBeenCalledWith(expect.objectContaining({
      intent: expect.objectContaining({ kind: "restart_gateway" }),
      requestedBy: expect.objectContaining({ surface: "gateway", user_id: "1001" }),
      replyTarget: expect.objectContaining({
        conversation_id: "chat-1",
        metadata: { runtime_control_approved: true },
      }),
      approvalFn: expect.any(Function),
    }));
  });

  it("blocks disallowed runtime-control lifecycle requests without service fallback", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-tools-denied-"));
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    const runtimeControlService = { request: vi.fn() };
    const tools = createSetupRuntimeControlTools({ stateManager, runtimeControlService });
    const requestTool = tools.find((tool) => tool.metadata.name === "request_runtime_control")!;
    const statusTool = tools.find((tool) => tool.metadata.name === "get_runtime_status")!;
    const context = makeContext(baseDir, {
      runtimeControlAllowed: false,
      runtimeControlApprovalMode: "disallowed",
      runtimeReplyTarget: {
        surface: "gateway",
        channel: "plugin_gateway",
        metadata: { runtime_control_denied: true },
      },
    });

    const blocked = await requestTool.call({
      operation: "restart_daemon",
      reason: "restart it",
    }, context);
    const status = await statusTool.call({}, context);

    expect(blocked.success).toBe(false);
    expect(blocked.data).toMatchObject({ status: "not_executed", reason: "runtime_control_disallowed" });
    expect(blocked.summary).toContain("will not fall back to shell tools");
    expect(status.success).toBe(true);
    expect(runtimeControlService.request).not.toHaveBeenCalled();
  });
});
