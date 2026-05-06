import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../../../base/state/state-manager.js";
import { getGatewayChannelDir } from "../../../base/utils/paths.js";
import { intakeSetupSecrets } from "../../../interface/chat/setup-secret-intake.js";
import { BackgroundRunLedger } from "../../../runtime/store/background-run-store.js";
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
    expect(result.data).toMatchObject({
      channel: "telegram",
      state: "unconfigured",
      next_action: { kind: "configure_bot_token", required: true },
      command_tokens: {
        recommended_path: [
          "pulseed telegram setup",
          "pulseed gateway setup",
          "pulseed daemon start",
          "pulseed daemon status",
        ],
        confirm_write: "/confirm-setup-write",
        set_home: "/sethome",
      },
      safety: {
        writes_config: false,
        writes_secret: false,
        requires_approval_before_write: true,
        shell_fallback_allowed: false,
      },
      pending_write: {
        exists: true,
        state: "confirm_write",
        secret_kind: "telegram_bot_token",
      },
      redaction: {
        raw_secret_in_summary: false,
        raw_secret_in_data: false,
        redaction_marker_present: true,
      },
    });
    const pending = await context.setupDialogue!.get() as SetupDialogueRuntimeState;
    expect(pending.publicState).toMatchObject({
      state: "confirm_write",
      selectedChannel: "telegram",
      pendingSecret: { kind: "telegram_bot_token" },
    });
    expect(pending.publicState.pendingSecret?.redaction).toBe("[REDACTED:telegram_bot_token:setup_secret_1]");
    expect(pending.secretValue).toBe("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi");
  });

  it("keeps non-English Latin-script setup requests language-general in typed data", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-setup-tools-spanish-"));
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    const [, guidanceTool] = createSetupRuntimeControlTools({
      stateManager,
      gatewaySetupStatusProvider: {
        getTelegramStatus: vi.fn().mockResolvedValue({
          channel: "telegram",
          state: "partially_configured",
          configPath: path.join(baseDir, "gateway/channels/telegram-bot/config.json"),
          daemon: { running: true, port: 41700 },
          gateway: { loadState: "unknown" },
          config: {
            exists: true,
            hasBotToken: true,
            hasHomeChat: false,
            allowAll: false,
            allowedUserCount: 1,
            runtimeControlAllowedUserCount: 0,
            identityKeyConfigured: true,
          },
        }),
      },
    });

    const result = await guidanceTool.call({
      channel: "telegram",
      request: "Quiero configurar Telegram para hablar con Seedy.",
    }, makeContext(baseDir, { setupSecretIntake: intakeSetupSecrets("Quiero configurar Telegram para hablar con Seedy.") }));

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      user_language: {
        preference: "same_as_user_turn",
        script: "latin",
      },
      next_action: { kind: "send_sethome" },
    });
    expect(result.summary).toContain("Telegram gateway status");
  });

  it("keeps non-Japanese non-Latin setup requests language-general in typed data", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-setup-tools-arabic-"));
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    const [, guidanceTool] = createSetupRuntimeControlTools({
      stateManager,
      gatewaySetupStatusProvider: {
        getTelegramStatus: vi.fn().mockResolvedValue({
          channel: "telegram",
          state: "configured",
          configPath: path.join(baseDir, "gateway/channels/telegram-bot/config.json"),
          daemon: { running: true, port: 41700 },
          gateway: { loadState: "unknown" },
          config: {
            exists: true,
            hasBotToken: true,
            hasHomeChat: true,
            allowAll: false,
            allowedUserCount: 1,
            runtimeControlAllowedUserCount: 1,
            identityKeyConfigured: true,
          },
        }),
      },
    });

    const result = await guidanceTool.call({
      channel: "telegram",
      request: "أريد إعداد تيليجرام للتحدث مع Seedy",
    }, makeContext(baseDir, { setupSecretIntake: intakeSetupSecrets("أريد إعداد تيليجرام للتحدث مع Seedy") }));

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      user_language: {
        preference: "same_as_user_turn",
        script: "other",
      },
      next_action: { kind: "verify_delivery" },
    });
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

  it("keeps generic request_runtime_control scoped to daemon and gateway operations", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-tools-generic-scope-"));
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    const tools = createSetupRuntimeControlTools({
      stateManager,
      runtimeControlService: { request: vi.fn() },
    });
    const requestTool = tools.find((tool) => tool.metadata.name === "request_runtime_control")!;
    const runCancel = tools.find((tool) => tool.metadata.name === "run_cancel")!;

    expect(requestTool.inputSchema.safeParse({
      operation: "pause_run",
      run_id: "run:coreloop:bypass",
      reason: "pause without observing",
    }).success).toBe(false);
    expect(requestTool.inputSchema.safeParse({
      operation: "restart_gateway",
      reason: "restart after config change",
    }).success).toBe(true);
    expect(runCancel.metadata.isDestructive).toBe(true);
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

  it("requests run_pause only when the exact observed run epoch still matches", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-tools-run-pause-"));
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    const ledger = new BackgroundRunLedger(path.join(baseDir, "runtime"));
    await ledger.create({
      id: "run:coreloop:pause-target",
      kind: "coreloop_run",
      goal_id: "goal-pause",
      notify_policy: "silent",
      reply_target_source: "none",
      status: "running",
      title: "Pause target",
      workspace: "/repo",
      created_at: "2026-05-06T00:00:00.000Z",
      started_at: "2026-05-06T00:01:00.000Z",
      updated_at: "2026-05-06T00:02:00.000Z",
    });
    const runtimeControlService = { request: vi.fn().mockResolvedValue({
      success: true,
      message: "pause queued",
      operationId: "op-run-pause",
      state: "approved",
    }) };
    const runPause = createSetupRuntimeControlTools({ stateManager, runtimeControlService }).find((tool) => tool.metadata.name === "run_pause")!;

    const result = await runPause.call({
      run_id: "run:coreloop:pause-target",
      observed_run_epoch: "2026-05-06T00:02:00.000Z",
      reason: "safe pause requested by operator",
    }, makeContext(baseDir));

    expect(result.success).toBe(true);
    expect(runtimeControlService.request).toHaveBeenCalledWith(expect.objectContaining({
      intent: {
        kind: "pause_run",
        reason: "safe pause requested by operator",
        target: { runId: "run:coreloop:pause-target" },
      },
      approvalFn: expect.any(Function),
    }));
  });

  it("rejects run control when the observed run epoch is stale", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-tools-run-stale-"));
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    const ledger = new BackgroundRunLedger(path.join(baseDir, "runtime"));
    await ledger.create({
      id: "run:coreloop:stale-target",
      kind: "coreloop_run",
      goal_id: "goal-stale",
      notify_policy: "silent",
      reply_target_source: "none",
      status: "running",
      title: "Stale target",
      workspace: "/repo",
      created_at: "2026-05-06T00:00:00.000Z",
      started_at: "2026-05-06T00:01:00.000Z",
      updated_at: "2026-05-06T00:03:00.000Z",
    });
    const runtimeControlService = { request: vi.fn() };
    const runCancel = createSetupRuntimeControlTools({ stateManager, runtimeControlService }).find((tool) => tool.metadata.name === "run_cancel")!;

    const result = await runCancel.call({
      run_id: "run:coreloop:stale-target",
      observed_run_epoch: "2026-05-06T00:02:00.000Z",
      reason: "cancel stale target",
    }, makeContext(baseDir));

    expect(result.success).toBe(false);
    expect(result.execution).toMatchObject({ status: "not_executed", reason: "stale_state" });
    expect(result.data).toMatchObject({
      status: "stale_state",
      current_run_epoch: "2026-05-06T00:03:00.000Z",
      observed_run_epoch: "2026-05-06T00:02:00.000Z",
    });
    expect(runtimeControlService.request).not.toHaveBeenCalled();
  });

  it("marks run_cancel approval requests as destructive", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-tools-run-cancel-approval-"));
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    const ledger = new BackgroundRunLedger(path.join(baseDir, "runtime"));
    await ledger.create({
      id: "run:coreloop:cancel-target",
      kind: "coreloop_run",
      goal_id: "goal-cancel",
      notify_policy: "silent",
      reply_target_source: "none",
      status: "running",
      title: "Cancel target",
      workspace: "/repo",
      created_at: "2026-05-06T00:00:00.000Z",
      started_at: "2026-05-06T00:01:00.000Z",
      updated_at: "2026-05-06T00:02:00.000Z",
    });
    const runtimeControlService = {
      request: vi.fn().mockImplementation(async (request: { approvalFn?: (reason: string) => Promise<boolean> }) => {
        await request.approvalFn?.("cancel requested");
        return {
          success: false,
          message: "Runtime control operation was not approved.",
          operationId: "op-cancel",
          state: "cancelled",
        };
      }),
    };
    const approvalFn = vi.fn().mockResolvedValue(false);
    const runCancel = createSetupRuntimeControlTools({ stateManager, runtimeControlService }).find((tool) => tool.metadata.name === "run_cancel")!;

    const result = await runCancel.call({
      run_id: "run:coreloop:cancel-target",
      observed_run_epoch: "2026-05-06T00:02:00.000Z",
      reason: "cancel active runtime run",
    }, makeContext(baseDir, {
      runtimeControlApprovalMode: "interactive",
      approvalFn,
    }));

    expect(result.success).toBe(false);
    expect(approvalFn).toHaveBeenCalledWith(expect.objectContaining({
      toolName: "run_cancel",
      isDestructive: true,
    }));
  });
});
