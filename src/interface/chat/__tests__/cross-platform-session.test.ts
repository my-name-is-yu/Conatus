import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import { CrossPlatformChatSessionManager } from "../cross-platform-session.js";
import type { CrossPlatformChatSessionOptions } from "../cross-platform-session.js";
import type { ChatRunnerDeps } from "../chat-runner.js";
import { ApprovalBroker } from "../../../runtime/approval-broker.js";
import { ApprovalStore } from "../../../runtime/store/approval-store.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { IAdapter, AgentResult } from "../../../orchestrator/execution/adapter-layer.js";
import { createMockLLMClient, createSingleMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { StateManager as RealStateManager } from "../../../base/state/state-manager.js";

vi.mock("../../../platform/observation/context-provider.js", () => ({
  resolveGitRoot: (cwd: string) => cwd,
  buildChatContext: (_task: string, cwd: string) => Promise.resolve(`Working directory: ${cwd}`),
}));

const CANNED_RESULT: AgentResult = {
  success: true,
  output: "Task completed successfully.",
  error: null,
  exit_code: 0,
  elapsed_ms: 50,
  stopped_reason: "completed",
};

function makeMockAdapter(result: AgentResult = CANNED_RESULT): IAdapter {
  return {
    adapterType: "mock",
    execute: vi.fn().mockResolvedValue(result),
  } as unknown as IAdapter;
}

function makeMockStateManager(): StateManager {
  return {
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

function makeDeps(overrides: Partial<ChatRunnerDeps> = {}): ChatRunnerDeps {
  return {
    stateManager: makeMockStateManager(),
    adapter: makeMockAdapter(),
    ...overrides,
  };
}

function getSessionPaths(stateManager: StateManager): string[] {
  const writeRawMock = stateManager.writeRaw as ReturnType<typeof vi.fn>;
  return writeRawMock.mock.calls
    .map((call: unknown[]) => call[0] as string)
    .filter((path: string) => path.startsWith("chat/sessions/"));
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function runSpecFreeformDecision(): string {
  return JSON.stringify({
    kind: "run_spec",
    confidence: 0.93,
    rationale: "Long-running background work request",
  });
}

function runSpecDraftDecision(): string {
  return JSON.stringify({
    decision: "run_spec_request",
    confidence: 0.92,
    profile: "kaggle",
    objective: "Continue Kaggle optimization until score exceeds 0.98",
    execution_target: { kind: "daemon", remote_host: null, confidence: "medium" },
    metric: {
      name: "kaggle_score",
      direction: "maximize",
      target: 0.98,
      target_rank_percent: null,
      datasource: "kaggle_leaderboard",
      confidence: "high",
    },
    progress_contract: {
      kind: "metric_target",
      dimension: "kaggle_score",
      threshold: 0.98,
      semantics: "Kaggle score exceeds 0.98.",
      confidence: "high",
    },
    deadline: {
      raw: "tomorrow morning",
      iso_at: "2026-05-04T00:00:00.000Z",
      timezone: "Asia/Tokyo",
      finalization_buffer_minutes: 30,
      confidence: "high",
    },
    budget: { max_trials: null, max_wall_clock_minutes: null, resident_policy: "best_effort" },
    approval_policy: {
      submit: "approval_required",
      publish: "unspecified",
      secret: "approval_required",
      external_action: "approval_required",
      irreversible_action: "approval_required",
    },
    missing_fields: [],
  });
}

function runSpecConfirmationDecision(decision: "approve" | "cancel" | "unknown" | "revise"): string {
  return JSON.stringify({
    decision,
    confidence: 0.94,
    rationale: "Typed RunSpec confirmation",
  });
}

describe("CrossPlatformChatSessionManager", () => {
  it("routes gateway natural-language long-running requests into a typed RunSpec draft", async () => {
    const baseDir = makeTempDir();
    try {
      const stateManager = new RealStateManager(baseDir, undefined, { walEnabled: false });
      const adapter = makeMockAdapter();
      const chatAgentLoopRunner = { execute: vi.fn() };
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        stateManager,
        adapter,
        chatAgentLoopRunner: chatAgentLoopRunner as never,
        llmClient: createMockLLMClient([
          runSpecFreeformDecision(),
          runSpecDraftDecision(),
        ]),
      }));

      const result = await manager.execute("Please keep improving this Kaggle run until score exceeds 0.98.", {
        identity_key: "telegram:user-1",
        platform: "telegram",
        conversation_id: "telegram-chat-1",
        user_id: "user-1",
        message_id: "message-1",
        cwd: "/repo/kaggle",
        metadata: { gateway_message: true },
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("Proposed long-running run:");
      expect(result.output).toContain("It has not started a daemon run.");
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
      const [fileName] = fs.readdirSync(`${baseDir}/run-specs`);
      const stored = JSON.parse(fs.readFileSync(`${baseDir}/run-specs/${fileName}`, "utf8"));
      expect(stored.status).toBe("draft");
      expect(stored.origin.channel).toBe("plugin_gateway");
      expect(stored.origin.reply_target).toMatchObject({
        conversation_id: "telegram-chat-1",
        message_id: "message-1",
        identity_key: "telegram:user-1",
      });
    } finally {
      cleanupTempDir(baseDir);
    }
  });

  it("starts a gateway natural-language RunSpec after approval and retains reply target metadata", async () => {
    const baseDir = makeTempDir();
    try {
      const stateManager = new RealStateManager(baseDir, undefined, { walEnabled: false });
      const adapter = makeMockAdapter();
      const chatAgentLoopRunner = { execute: vi.fn() };
      const daemonClient = { startGoal: vi.fn().mockResolvedValue({ ok: true }) };
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        stateManager,
        adapter,
        chatAgentLoopRunner: chatAgentLoopRunner as never,
        daemonClient: daemonClient as never,
        llmClient: createMockLLMClient([
          runSpecFreeformDecision(),
          runSpecDraftDecision(),
          JSON.stringify({ kind: "assist", confidence: 0.9, rationale: "Approval turn is handled by pending confirmation." }),
          runSpecConfirmationDecision("approve"),
        ]),
      }));

      const draft = await manager.execute("Kaggle score 0.98を超えるまで長期で回して", {
        identity_key: "telegram:user-longrun",
        platform: "telegram",
        conversation_id: "telegram-chat-longrun",
        user_id: "user-longrun",
        message_id: "message-draft",
        cwd: "/repo/kaggle",
        metadata: { gateway_message: true, request_id: "gateway-req-1" },
      });
      const approved = await manager.execute("承認します", {
        identity_key: "telegram:user-longrun",
        platform: "telegram",
        conversation_id: "telegram-chat-longrun",
        user_id: "user-longrun",
        message_id: "message-approve",
        cwd: "/repo/kaggle",
        metadata: { gateway_message: true, request_id: "gateway-req-2" },
      });

      expect(draft.success).toBe(true);
      expect(draft.output).toContain("It has not started a daemon run.");
      expect(approved.success).toBe(true);
      expect(approved.output).toContain("Started daemon-backed DurableLoop goal:");
      expect(daemonClient.startGoal).toHaveBeenCalledOnce();
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();

      const [runFileName] = fs.readdirSync(`${baseDir}/runtime/background-runs`);
      const run = JSON.parse(fs.readFileSync(`${baseDir}/runtime/background-runs/${runFileName}`, "utf8"));
      expect(run).toMatchObject({
        status: "queued",
        workspace: "/repo/kaggle",
        parent_session_id: expect.stringMatching(/^session:conversation:/),
        reply_target_source: "pinned_run",
        pinned_reply_target: {
          channel: "gateway",
          target_id: "telegram-chat-longrun",
          thread_id: "message-draft",
          metadata: {
            conversation_id: "telegram-chat-longrun",
            message_id: "message-draft",
            identity_key: "telegram:user-longrun",
            request_id: "gateway-req-1",
          },
        },
        origin_metadata: {
          run_spec_origin: {
            channel: "plugin_gateway",
            reply_target: {
              conversation_id: "telegram-chat-longrun",
              message_id: "message-draft",
              identity_key: "telegram:user-longrun",
            },
          },
        },
      });
      expect(daemonClient.startGoal).toHaveBeenCalledWith(
        expect.stringMatching(/^goal-runspec-/),
        expect.objectContaining({
          backgroundRun: expect.objectContaining({
            backgroundRunId: run.id,
            parentSessionId: run.parent_session_id,
            replyTargetSource: "pinned_run",
            pinnedReplyTarget: expect.objectContaining({
              target_id: "telegram-chat-longrun",
            }),
          }),
        }),
      );
    } finally {
      cleanupTempDir(baseDir);
    }
  });

  it("routes token-only setup follow-up through typed secret intake instead of adapter execution", async () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const llmClient = createMockLLMClient([
      JSON.stringify({ kind: "assist", confidence: 0.95, rationale: "generic fallback" }),
    ]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      llmClient,
      chatAgentLoopRunner: {
        execute: vi.fn(),
      } as never,
    }));

    const result = await manager.execute(token, {
      identity_key: "telegram:user-1",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      metadata: { runtime_control_approved: true },
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("I received a Telegram bot token");
    expect(result.output).not.toContain(token);
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(JSON.stringify((stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(token);
  });

  it("reuses the same ChatRunner session for the same identity_key across platforms", async () => {
    const stateManager = makeMockStateManager();
    const manager = new CrossPlatformChatSessionManager(makeDeps({ stateManager }));
    const events: string[] = [];

    const first = await manager.execute("hello from slack", {
      identity_key: "user-123",
      platform: "slack",
      conversation_id: "conv-1",
      user_id: "user-a",
      cwd: "/repo",
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    const second = await manager.execute("hello from discord", {
      identity_key: "user-123",
      platform: "discord",
      conversation_id: "thread-9",
      user_id: "user-a",
      cwd: "/repo",
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    const sessionPaths = getSessionPaths(stateManager);
    expect(new Set(sessionPaths).size).toBe(1);
    expect(sessionPaths[0]).toMatch(/^chat\/sessions\/.+\.json$/);

    const info = manager.getSessionInfo({ identity_key: "user-123" } satisfies CrossPlatformChatSessionOptions);
    expect(info).not.toBeNull();
    expect(info?.identity_key).toBe("user-123");
    expect(info?.platform).toBe("slack");
    expect(info?.conversation_id).toBe("conv-1");
    expect(info?.cwd).toBe("/repo");
    expect(info?.metadata).toMatchObject({
      channel: "plugin_gateway",
      platform: "discord",
      conversation_id: "thread-9",
      user_id: "user-a",
    });
    expect(info?.active_reply_target).toMatchObject({
      surface: "gateway",
      platform: "discord",
      conversation_id: "thread-9",
      identity_key: "user-123",
      user_id: "user-a",
    });

    expect(events).toContain("lifecycle_start");
    expect(events).toContain("assistant_final");
  });

  it("keeps sessions isolated when identity_key is omitted", async () => {
    const stateManager = makeMockStateManager();
    const manager = new CrossPlatformChatSessionManager(makeDeps({ stateManager }));

    const sharedOptions: Omit<CrossPlatformChatSessionOptions, "identity_key" | "platform"> = {
      conversation_id: "conv-1",
      user_id: "user-a",
      cwd: "/repo",
    };

    await manager.execute("hello from slack", {
      ...sharedOptions,
      platform: "slack",
    });

    await manager.execute("hello from discord", {
      ...sharedOptions,
      platform: "discord",
    });

    const sessionPaths = getSessionPaths(stateManager);
    expect(new Set(sessionPaths).size).toBe(2);
  });

  it("streams ChatEvent updates through the per-turn callback", async () => {
    const stateManager = makeMockStateManager();
    const manager = new CrossPlatformChatSessionManager(makeDeps({ stateManager }));
    const events: Array<{ type: string; text?: string }> = [];

    const result = await manager.execute("stream this turn", {
      identity_key: "stream-user",
      platform: "web",
      conversation_id: "web-1",
      cwd: "/repo",
      onEvent: (event) => {
        events.push({ type: event.type, text: "text" in event ? event.text : undefined });
      },
    });

    expect(result.success).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "lifecycle_start")).toBe(true);
    expect(events.some((event) => event.type === "assistant_delta")).toBe(true);
    expect(events.some((event) => event.type === "assistant_final")).toBe(true);
    expect(events.at(-1)?.type).toBe("lifecycle_end");
  });

  it("drains async per-turn event delivery before returning to gateway callers", async () => {
    const stateManager = makeMockStateManager();
    const manager = new CrossPlatformChatSessionManager(makeDeps({ stateManager }));
    const finalDelivery = createDeferred();
    let finalHandlerEntered = false;
    let finalDelivered = false;

    const run = manager.processIncomingMessage({
      text: "stream this gateway turn",
      platform: "slack",
      identity_key: "workspace:U123",
      conversation_id: "C123:1700.1",
      sender_id: "U123",
      message_id: "1700.2",
      cwd: "/repo",
      onEvent: async (event) => {
        if (event.type !== "assistant_final") return;
        finalHandlerEntered = true;
        await finalDelivery.promise;
        finalDelivered = true;
      },
    });

    await vi.waitFor(() => {
      expect(finalHandlerEntered).toBe(true);
    });
    await expect(Promise.race([
      run.then(() => "returned"),
      Promise.resolve().then(() => "pending"),
    ])).resolves.toBe("pending");

    finalDelivery.resolve();
    await expect(run).resolves.toBe("Task completed successfully.");
    expect(finalDelivered).toBe(true);
  });

  it("isolates async event delivery failures and still returns the chat result", async () => {
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
    }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await manager.processIncomingMessage({
      text: "stream this gateway turn",
      platform: "discord",
      conversation_id: "D123",
      sender_id: "U123",
      cwd: "/repo",
      onEvent: async (event) => {
        if (event.type === "assistant_final") {
          throw new Error("discord delivery failed");
        }
      },
    });

    expect(result).toBe("Task completed successfully.");
    expect(warnSpy).toHaveBeenCalledWith("[chat] event delivery failed", expect.objectContaining({
      eventType: "assistant_final",
      error: "discord delivery failed",
    }));
    warnSpy.mockRestore();
  });

  it("returns recovery guidance for gateway-visible failures", async () => {
    const adapter = makeMockAdapter({
      ...CANNED_RESULT,
      success: false,
      output: "Agent failed",
      error: "boom",
      exit_code: 1,
    });
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      adapter,
    }));

    const result = await manager.processIncomingMessage({
      text: "do risky work",
      platform: "slack",
      conversation_id: "C_GENERAL",
      sender_id: "U123",
      cwd: "/repo",
    });

    expect(result).toContain("Agent failed");
    expect(result).toContain("Recovery");
    expect(result).toContain("Next actions");
  });

  it("routes natural-language restart with the current platform reply target", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const runtimeControlService = {
      request: vi.fn().mockResolvedValue({
        success: true,
        message: "restart queued",
        operationId: "op-1",
        state: "acknowledged",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      llmClient: createSingleMockLLMClient(JSON.stringify({
        intent: "restart_daemon",
        reason: "PulSeed を再起動して",
      })),
      runtimeControlService,
      approvalFn: vi.fn().mockResolvedValue(true),
    }));

    const result = await manager.execute("PulSeed を再起動して", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      metadata: { runtime_control_approved: true },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("restart queued");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(runtimeControlService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ kind: "restart_daemon" }),
        replyTarget: expect.objectContaining({
          surface: "gateway",
          platform: "telegram",
          conversation_id: "telegram-chat-1",
          identity_key: "owner",
          user_id: "user-1",
        }),
        requestedBy: expect.objectContaining({
          surface: "gateway",
          platform: "telegram",
          conversation_id: "telegram-chat-1",
        }),
      })
    );

    const info = manager.getSessionInfo({ identity_key: "owner" });
    expect(info?.active_reply_target).toMatchObject({
      surface: "gateway",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      identity_key: "owner",
      user_id: "user-1",
    });
  });

  it("fails closed for natural-language daemon restart when runtime control is unavailable", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "agent loop should not run shell fallback",
        error: null,
        exit_code: null,
        elapsed_ms: 42,
        stopped_reason: "completed",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
      llmClient: createMockLLMClient([
        JSON.stringify({
          intent: "restart_daemon",
          reason: "PulSeed を再起動して",
        }),
      ]),
    }));

    const result = await manager.execute("PulSeed を再起動して", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      runtimeControl: {
        allowed: true,
        approvalMode: "interactive",
      },
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("runtime-control service is not available");
    expect(result.output).toContain("operation was not executed");
    expect(result.output).toContain("will not fall back to shell tools");
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("fails closed for default local daemon restart when runtime control is unavailable", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "agent loop should not run shell fallback",
        error: null,
        exit_code: null,
        elapsed_ms: 42,
        stopped_reason: "completed",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
      llmClient: createMockLLMClient([
        JSON.stringify({
          intent: "restart_daemon",
          reason: "PulSeed を再起動して",
        }),
      ]),
    }));

    const result = await manager.execute("PulSeed を再起動して", {
      identity_key: "local",
      cwd: "/repo",
      runtimeControl: {
        allowed: true,
        approvalMode: "interactive",
      },
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("runtime-control service is not available");
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("does not preempt ordinary disallowed gateway setup when runtime-control service is wired", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const runtimeControlService = {
      request: vi.fn().mockResolvedValue({
        success: true,
        message: "runtime control should not run",
      }),
    };
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "agent loop should not run",
        error: null,
        exit_code: null,
        elapsed_ms: 42,
        stopped_reason: "completed",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
      llmClient: createMockLLMClient([
        JSON.stringify({ kind: "configure", confidence: 0.9, configure_target: "telegram_gateway", rationale: "setup request" }),
      ]),
      runtimeControlService,
    }));

    const result = await manager.execute("Telegram bot setup help", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      metadata: { runtime_control_denied: true },
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("@BotFather");
    expect(runtimeControlService.request).not.toHaveBeenCalled();
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("fails closed for unauthorized gateway daemon restart instead of using agent-loop shell fallback", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "agent loop should not run shell fallback",
        error: null,
        exit_code: null,
        elapsed_ms: 42,
        stopped_reason: "completed",
      }),
    };
    const runtimeControlService = {
      request: vi.fn().mockResolvedValue({
        success: true,
        message: "runtime control should not run",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
      llmClient: createMockLLMClient([
        "not a freeform route decision",
        JSON.stringify({
          intent: "restart_daemon",
          reason: "PulSeed を再起動して",
        }),
      ]),
      runtimeControlService,
    }));

    const result = await manager.execute("PulSeed を再起動して", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      metadata: { runtime_control_denied: true },
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("not authorized for runtime-control lifecycle actions");
    expect(result.output).toContain("operation was not executed");
    expect(result.output).toContain("will not fall back to shell tools");
    expect(runtimeControlService.request).not.toHaveBeenCalled();
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("routes gateway natural-language run pause to runtime control with current reply target", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const runtimeControlService = {
      request: vi.fn().mockResolvedValue({
        success: true,
        message: "pause queued",
        operationId: "op-1",
        state: "running",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      llmClient: createSingleMockLLMClient(JSON.stringify({
        intent: "pause_run",
        reason: "この実行を一時停止して",
      })),
      runtimeControlService,
      runtimeControlApprovalFn: vi.fn().mockResolvedValue(true),
    }));

    const result = await manager.execute("この実行を一時停止して", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      runtimeControl: {
        allowed: true,
        approvalMode: "interactive",
      },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("pause queued");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(runtimeControlService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ kind: "pause_run" }),
        replyTarget: expect.objectContaining({
          surface: "gateway",
          platform: "telegram",
          conversation_id: "telegram-chat-1",
          identity_key: "owner",
          user_id: "user-1",
        }),
        requestedBy: expect.objectContaining({
          surface: "gateway",
          platform: "telegram",
          conversation_id: "telegram-chat-1",
        }),
      })
    );
  });

  it("routes runtime-control approval through the originating conversation metadata", async () => {
    const tmpDir = makeTempDir();
    const events: string[] = [];
    try {
      const store = new ApprovalStore(tmpDir);
      const approvalBroker = new ApprovalBroker({
        store,
        createId: () => "approval-cross-platform",
      });
      const runtimeControlService = {
        request: vi.fn(async (request: {
          approvalFn?: (description: string) => Promise<boolean>;
        }) => {
          const approved = await request.approvalFn?.("Restart the resident daemon.");
          return {
            success: approved === true,
            message: approved === true ? "restart queued" : "not approved",
            operationId: "op-approval",
            state: approved === true ? "acknowledged" as const : "blocked" as const,
          };
        }),
      };
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        llmClient: createSingleMockLLMClient(JSON.stringify({
          intent: "restart_daemon",
          reason: "PulSeed を再起動して",
        })),
        runtimeControlService,
        approvalBroker,
      }));

      const resultPromise = manager.processIncomingMessage({
        text: "PulSeed を再起動して",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        onEvent: (event) => {
          if (event.type === "activity") {
            events.push(event.message);
          }
        },
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
        },
      });

      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && !events.some((message) => message.includes("Approval ID: approval-cross-platform"))) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(manager.processIncomingMessage({
        text: "",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        approvalResponse: {
          approval_id: "approval-cross-platform",
          approved: true,
        },
      })).resolves.toBe("Approval response recorded.");

      const result = await resultPromise;
      expect(result).toBe("restart queued");
      expect(events.some((message) =>
        message.includes("Approval required.")
        && message.includes("Restart the resident daemon.")
        && message.includes("Approval ID: approval-cross-platform")
      )).toBe(true);
      const resolved = await store.loadResolved("approval-cross-platform");
      expect(resolved).toMatchObject({
        state: "approved",
        response_channel: "slack",
        origin: {
          channel: "slack",
          conversation_id: "C123:1700.1",
          user_id: "U123",
          session_id: "identity:workspace:U123",
          turn_id: "1700.2",
        },
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("parses a same-conversation natural-language approval reply through the production ingress path", async () => {
    const tmpDir = makeTempDir();
    const events: string[] = [];
    try {
      const store = new ApprovalStore(tmpDir);
      const approvalBroker = new ApprovalBroker({
        store,
        createId: () => "approval-natural-language",
      });
      const runtimeControlService = {
        request: vi.fn(async (request: {
          approvalFn?: (description: string) => Promise<boolean>;
        }) => {
          const approved = await request.approvalFn?.("Restart the resident daemon.");
          return {
            success: approved === true,
            message: approved === true ? "restart queued" : "not approved",
            operationId: "op-natural-language",
            state: approved === true ? "acknowledged" as const : "blocked" as const,
          };
        }),
      };
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        llmClient: createMockLLMClient([
          JSON.stringify({
            intent: "restart_daemon",
            reason: "PulSeed を再起動して",
          }),
          JSON.stringify({
            decision: "approve",
            confidence: 0.94,
            rationale: "The reply explicitly authorizes the active restart request.",
          }),
        ]),
        runtimeControlService,
        approvalBroker,
      }));

      const resultPromise = manager.processIncomingMessage({
        text: "PulSeed を再起動して",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        onEvent: (event) => {
          if (event.type === "activity") {
            events.push(event.message);
          }
        },
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
        },
      });

      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && !events.some((message) => message.includes("approval-natural-language"))) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(manager.processIncomingMessage({
        text: "問題ありません。進めてください",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.3",
        cwd: "/repo",
      })).resolves.toBe("Approval response recorded.");

      await expect(resultPromise).resolves.toBe("restart queued");
      await expect(store.loadResolved("approval-natural-language")).resolves.toMatchObject({
        state: "approved",
        response_channel: "slack",
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("keeps approvals pending for clarification replies and rejects wrong-context replies", async () => {
    const tmpDir = makeTempDir();
    try {
      const store = new ApprovalStore(tmpDir);
      const approvalBroker = new ApprovalBroker({
        store,
        createId: () => "approval-clarify",
      });
      const runtimeControlService = {
        request: vi.fn(async (request: {
          approvalFn?: (description: string) => Promise<boolean>;
        }) => {
          const approved = await request.approvalFn?.("Restart the resident daemon.");
          return {
            success: approved === true,
            message: approved === true ? "restart queued" : "not approved",
            operationId: "op-clarify",
            state: approved === true ? "acknowledged" as const : "blocked" as const,
          };
        }),
      };
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        llmClient: createMockLLMClient([
          JSON.stringify({
            intent: "restart_daemon",
            reason: "PulSeed を再起動して",
          }),
          JSON.stringify({
            decision: "clarify",
            confidence: 0.92,
            clarification: "Approval is still pending while the restart target is clarified.",
          }),
        ]),
        runtimeControlService,
        approvalBroker,
      }));

      const resultPromise = manager.processIncomingMessage({
        text: "PulSeed を再起動して",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        onEvent: () => undefined,
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
        },
      });
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && (await store.loadPending("approval-clarify")) === null) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await expect(manager.processIncomingMessage({
        text: "Before deciding, which daemon will restart?",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.3",
        cwd: "/repo",
      })).resolves.toBe("Approval is still pending while the restart target is clarified.");
      await expect(store.loadPending("approval-clarify")).resolves.toMatchObject({
        state: "pending",
      });

      await expect(manager.processIncomingMessage({
        text: "",
        platform: "slack",
        identity_key: "workspace:U999",
        conversation_id: "C123:1700.1",
        sender_id: "U999",
        message_id: "1700.4",
        cwd: "/repo",
        approvalResponse: {
          approval_id: "approval-clarify",
          approved: true,
        },
      })).resolves.toBe("Approval response did not match an active approval for this conversation.");
      await expect(store.loadPending("approval-clarify")).resolves.toMatchObject({
        state: "pending",
      });

      await approvalBroker.resolveConversationalApproval("approval-clarify", false, {
        channel: "slack",
        conversation_id: "C123:1700.1",
        user_id: "U123",
        session_id: "identity:workspace:U123",
        turn_id: "1700.2",
      });
      await expect(resultPromise).resolves.toContain("not approved");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("fails closed when the originating conversation delivery handler rejects", async () => {
    const tmpDir = makeTempDir();
    try {
      const store = new ApprovalStore(tmpDir);
      const approvalBroker = new ApprovalBroker({
        store,
        createId: () => "approval-delivery-failure",
      });
      const runtimeControlService = {
        request: vi.fn(async (request: {
          approvalFn?: (description: string) => Promise<boolean>;
        }) => {
          const approved = await request.approvalFn?.("Restart the resident daemon.");
          return {
            success: approved === true,
            message: approved === true ? "restart queued" : "not approved",
            operationId: "op-approval",
            state: approved === true ? "acknowledged" as const : "blocked" as const,
          };
        }),
      };
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        llmClient: createSingleMockLLMClient(JSON.stringify({
          intent: "restart_daemon",
          reason: "PulSeed を再起動して",
        })),
        runtimeControlService,
        approvalBroker,
      }));

      const result = await manager.processIncomingMessage({
        text: "PulSeed を再起動して",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        onEvent: async () => {
          throw new Error("slack delivery failed");
        },
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
        },
      });

      expect(result).toContain("not approved");
      const resolved = await store.loadResolved("approval-delivery-failure");
      expect(resolved).toMatchObject({
        state: "denied",
        response_channel: "slack",
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("does not route broad finish text to runtime control without run context", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "Agent loop handles ordinary finish request",
        error: null,
        exit_code: null,
        elapsed_ms: 42,
        stopped_reason: "completed",
      }),
    };
    const runtimeControlService = {
      request: vi.fn().mockResolvedValue({
        success: true,
        message: "runtime control should not run",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
      llmClient: createMockLLMClient([
        JSON.stringify({
          intent: "none",
          reason: "ordinary implementation finish request",
        }),
        JSON.stringify({
          kind: "execute",
          confidence: 0.94,
          rationale: "ordinary implementation finish request",
        }),
      ]),
      runtimeControlService,
      runtimeControlApprovalFn: vi.fn().mockResolvedValue(true),
    }));

    const result = await manager.execute("finish the implementation", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      runtimeControl: {
        allowed: true,
        approvalMode: "interactive",
      },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Agent loop handles ordinary finish request");
    expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(runtimeControlService.request).not.toHaveBeenCalled();
  });

  it("routes gateway Telegram setup requests to configure guidance before agent-loop execution", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "agent loop should not run",
        error: null,
        exit_code: null,
        elapsed_ms: 42,
        stopped_reason: "completed",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
      llmClient: createMockLLMClient([
        JSON.stringify({
          kind: "configure",
          configure_target: "telegram_gateway",
          confidence: 0.96,
          rationale: "user wants Telegram chat setup",
        }),
      ]),
    }));

    const result = await manager.execute("telegramからseedyと会話できるようにしたい", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("@BotFather");
    expect(result.output).toContain("pulseed telegram setup");
    expect(result.output).toContain("pulseed gateway setup");
    expect(result.output).toContain("pulseed daemon start");
    expect(result.output).toContain("pulseed daemon status");
    expect(result.output).toContain("Telegram gateway status");
    expect(result.output).toContain("Telegram: まだ設定されていません");
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("routes long-running work through the native agent loop and leaves durable handoff to tools", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "Agent loop can choose core_tend_goal when durable DurableLoop handoff is needed.",
        error: null,
        exit_code: null,
        elapsed_ms: 42,
        stopped_reason: "completed",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
    }));

    const result = await manager.execute("coreloopの方でscore0.98行くまで取り組んで", {
      identity_key: "owner",
      channel: "tui",
      platform: "local_tui",
      conversation_id: "tui-session",
      cwd: "/repo",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("core_tend_goal");
    expect(chatAgentLoopRunner.execute).toHaveBeenCalledWith(expect.objectContaining({
      message: "coreloopの方でscore0.98行くまで取り組んで",
      cwd: "/repo",
    }));
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("serializes concurrent turns for the same shared session across channels", async () => {
    let activeCalls = 0;
    let maxConcurrentCalls = 0;
    const adapter = {
      adapterType: "mock",
      execute: vi.fn().mockImplementation(async () => {
        activeCalls += 1;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCalls -= 1;
        return CANNED_RESULT;
      }),
    } as unknown as IAdapter;
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      adapter,
    }));

    await Promise.all([
      manager.processIncomingMessage({
        text: "turn one",
        identity_key: "shared-user",
        platform: "discord",
        conversation_id: "discord-1",
        sender_id: "u-1",
        cwd: "/repo",
      }),
      manager.processIncomingMessage({
        text: "turn two",
        identity_key: "shared-user",
        platform: "telegram",
        conversation_id: "telegram-2",
        sender_id: "u-1",
        cwd: "/repo",
      }),
    ]);

    expect(adapter.execute).toHaveBeenCalledTimes(2);
    expect(maxConcurrentCalls).toBe(1);
  });

  it("passes gateway-routed goal_id into ChatRunner agent-loop execution", async () => {
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "Agent loop response",
        error: null,
        exit_code: 0,
        elapsed_ms: 42,
        stopped_reason: "completed",
      }),
    };
    const adapter = makeMockAdapter();
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
    }));

    const result = await manager.processIncomingMessage({
      text: "implement this",
      platform: "slack",
      conversation_id: "C_GENERAL",
      sender_id: "U123",
      goal_id: "goal-routed",
      metadata: { goal_id: "goal-metadata-only" },
      cwd: "/repo",
    });
    await manager.processIncomingMessage({
      text: "implement next thing",
      platform: "slack",
      conversation_id: "C_GENERAL",
      sender_id: "U123",
      goal_id: "goal-next",
      cwd: "/repo",
    });

    expect(result).toBe("Agent loop response");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(chatAgentLoopRunner.execute).toHaveBeenCalledTimes(2);
    expect(chatAgentLoopRunner.execute).toHaveBeenNthCalledWith(1, expect.objectContaining({
      goalId: "goal-routed",
    }));
    expect(chatAgentLoopRunner.execute).toHaveBeenNthCalledWith(2, expect.objectContaining({
      goalId: "goal-next",
    }));
  });
});
