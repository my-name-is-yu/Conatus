import { describe, expect, it, vi } from "vitest";
import { defaultExecutionPolicy } from "../../../orchestrator/execution/agent-loop/execution-policy.js";
import {
  buildChatTurnContext,
  renderModelVisibleTurnContext,
  toTurnContextSnapshot,
} from "../turn-context.js";
import type { UserInput } from "../user-input.js";

describe("Chat TurnContext", () => {
  it("keeps current runtime target model-visible and leaves stale fallback plus approval functions host-only", () => {
    const approvalFn = vi.fn().mockResolvedValue(true);
    const context = buildChatTurnContext({
      eventContext: { runId: "run-current", turnId: "turn-current" },
      startedAt: new Date("2026-05-06T07:00:00.000Z"),
      timezone: "Asia/Tokyo",
      sessionId: "session-current",
      cwd: "/repo",
      gitRoot: "/repo",
      executionCwd: "/repo",
      nativeAgentLoopStatePath: "chat/agentloop/session-current.state.json",
      selectedRoute: {
        kind: "agent_loop",
        reason: "agent_loop_available",
        replyTargetPolicy: "turn_reply_target",
        eventProjectionPolicy: "turn_only",
        concurrencyPolicy: "session_serial",
      },
      input: "進捗を見て",
      userInput: {
        schema_version: "user-input-v1",
        rawText: "進捗を見て",
        metadata: { token: "secret-metadata" },
        items: [
          { kind: "text", text: "secret-text" },
          {
            kind: "attachment",
            id: "attachment-1",
            name: "debug.log",
            mimeType: "text/plain",
            path: "/private/secret.log",
            url: "https://example.invalid/?token=secret-url",
            metadata: { apiKey: "secret-item-metadata" },
          },
        ],
      } satisfies UserInput,
      priorTurns: [],
      basePrompt: "Working directory: /repo\n\n進捗を見て",
      prompt: "Working directory: /repo\n\n進捗を見て",
      systemPrompt: "Developer instructions\n\nAGENTS instructions",
      agentLoopSystemPrompt: "Developer instructions\n\nAGENTS instructions\n\nReply in Japanese.",
      runtimeControlContext: {
        approvalMode: "preapproved",
        allowed: true,
        approvalFn,
        replyTarget: {
          surface: "gateway",
          platform: "slack",
          conversation_id: "current-thread",
          message_id: "current-message",
          identity_key: "current-user",
          user_id: "U-current",
        },
      },
      fallbackReplyTarget: {
        surface: "gateway",
        platform: "slack",
        conversation_id: "stale-thread",
        message_id: "stale-message",
        identity_key: "stale-user",
      },
      executionPolicy: defaultExecutionPolicy("/repo"),
      setupDialogue: null,
      runSpecConfirmation: null,
      setupSecretIntake: {
        redactedText: "進捗を見て",
        suppliedSecrets: [{
          id: "setup_secret_1",
          kind: "telegram_bot_token",
          value: "secret-token",
          redaction: "[REDACTED]",
          suppliedAt: "2026-05-06T07:00:00.000Z",
        }],
      },
      activatedTools: new Set(["sessions_read"]),
    });

    expect(context.modelVisible.runtime.replyTarget).toMatchObject({
      conversation_id: "current-thread",
      message_id: "current-message",
    });
    expect(context.modelVisible.runtime.approvalMode).toBe("preapproved");
    expect(context.hostOnly.runtime.fallbackReplyTarget).toMatchObject({
      conversation_id: "stale-thread",
    });

    const rendered = renderModelVisibleTurnContext(context.modelVisible);
    expect(rendered).toContain("current-thread");
    expect(rendered).not.toContain("stale-thread");

    const snapshotJson = JSON.stringify(toTurnContextSnapshot(context));
    expect(snapshotJson).toContain("current-thread");
    expect(snapshotJson).toContain("AGENTS instructions");
    expect(snapshotJson).toContain("進捗を見て");
    expect(snapshotJson).not.toContain("stale-thread");
    expect(snapshotJson).not.toContain("secret-text");
    expect(snapshotJson).not.toContain("secret-token");
    expect(snapshotJson).not.toContain("secret-metadata");
    expect(snapshotJson).not.toContain("secret-item-metadata");
    expect(snapshotJson).not.toContain("secret-url");
    expect(snapshotJson).not.toContain("/private/secret.log");
    expect(snapshotJson).not.toContain("approvalFn");
  });
});
