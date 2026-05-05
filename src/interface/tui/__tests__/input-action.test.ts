import { describe, expect, it } from "vitest";
import { resolveTuiInputAction } from "../input-action.js";

const chatRunnerSlash = (input: string): boolean => input.trim().toLowerCase().split(/\s+/)[0] === "/status";

function baseContext(overrides: Partial<Parameters<typeof resolveTuiInputAction>[1]> = {}): Parameters<typeof resolveTuiInputAction>[1] {
  return {
    isProcessing: false,
    hasChatRunner: true,
    hasPendingRunSpec: false,
    hasStandaloneSlashHandlers: true,
    isDaemonMode: false,
    daemonGoalId: null,
    isChatRunnerOwnedSlashCommand: chatRunnerSlash,
    ...overrides,
  };
}

describe("resolveTuiInputAction", () => {
  it("routes processing input to interrupt redirect only when ChatRunner is available", () => {
    expect(resolveTuiInputAction("show me the diff", baseContext({ isProcessing: true }))).toMatchObject({
      kind: "interrupt_redirect",
    });
    expect(resolveTuiInputAction("show me the diff", baseContext({ isProcessing: true, hasChatRunner: false }))).toMatchObject({
      kind: "ignore_processing",
    });
  });

  it("keeps shell mode ahead of slash, RunSpec, and freeform routing", () => {
    expect(resolveTuiInputAction("!pwd", baseContext({
      hasPendingRunSpec: true,
      isDaemonMode: true,
      daemonGoalId: "goal-1",
    }))).toEqual({
      kind: "shell",
      input: "!pwd",
      command: "pwd",
    });
    expect(resolveTuiInputAction("!", baseContext())).toMatchObject({
      kind: "shell_missing_command",
    });
  });

  it("routes ChatRunner-owned slash commands before pending RunSpec and standalone slash handling", () => {
    expect(resolveTuiInputAction("/status", baseContext({ hasPendingRunSpec: true }))).toMatchObject({
      kind: "chat_runner_slash",
    });
  });

  it("routes pending RunSpec confirmation before generic slash handlers", () => {
    expect(resolveTuiInputAction("confirm", baseContext({ hasPendingRunSpec: true }))).toMatchObject({
      kind: "pending_run_spec_confirmation",
    });
    expect(resolveTuiInputAction("/start goal-1", baseContext({ hasPendingRunSpec: true }))).toMatchObject({
      kind: "pending_run_spec_confirmation",
    });
  });

  it("routes non-ChatRunner slash commands to standalone handlers before daemon slash handlers", () => {
    expect(resolveTuiInputAction("/settings", baseContext({ isDaemonMode: true }))).toMatchObject({
      kind: "standalone_slash",
      trimmedInput: "/settings",
    });
  });

  it("routes daemon slash commands when standalone handlers are unavailable", () => {
    expect(resolveTuiInputAction("/start goal-1", baseContext({
      hasStandaloneSlashHandlers: false,
      isDaemonMode: true,
    }))).toMatchObject({
      kind: "daemon_slash",
      trimmedInput: "/start goal-1",
    });
  });

  it("keeps AgentLoop-capable chat surfaces on ChatRunner before daemon goal fallback", () => {
    expect(resolveTuiInputAction("Run this Kaggle competition", baseContext({
      isDaemonMode: true,
      daemonGoalId: "goal-1",
      hasChatRunner: true,
    }))).toMatchObject({
      kind: "freeform",
      route: "chat_runner",
    });
  });

  it("falls back to daemon goal chat only without ChatRunner and with a current daemon goal", () => {
    expect(resolveTuiInputAction("status?", baseContext({
      hasChatRunner: false,
      isDaemonMode: true,
      daemonGoalId: "goal-current",
    }))).toMatchObject({
      kind: "freeform",
      route: "daemon_goal_chat",
    });
  });

  it("rejects stale or missing daemon targets instead of reusing a previous target", () => {
    expect(resolveTuiInputAction("status?", baseContext({
      hasChatRunner: false,
      isDaemonMode: true,
      daemonGoalId: null,
    }))).toMatchObject({
      kind: "freeform",
      route: "unavailable",
    });
  });
});
