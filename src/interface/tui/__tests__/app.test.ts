import React from "react";
import { render } from "ink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../../../runtime/daemon/client.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { TuiChatSurface } from "../chat-surface.js";
import { App, formatDaemonConnectionState } from "../app.js";

const testState = vi.hoisted(() => ({
  lastChatProps: null as null | { onSubmit: (value: string) => Promise<void> },
  lastApprovalProps: null as null | {
    task: { work_description: string; rationale: string; goal_id: string };
    onDecision: (approved: boolean) => void;
  },
}));

vi.mock("ink", async () => {
  const actual = await vi.importActual<typeof import("ink")>("ink");
  return {
    ...actual,
    useInput: vi.fn(),
    useStdout: () => ({ stdout: { columns: 80, rows: 24 } }),
  };
});

vi.mock("../chat.js", async () => {
  return {
    Chat: (props: Record<string, unknown>) => {
      testState.lastChatProps = props as any;
      return null;
    },
  };
});

vi.mock("../fullscreen-chat.js", async () => {
  return {
    FullscreenChat: (props: Record<string, unknown>) => {
      testState.lastChatProps = props as any;
      return null;
    },
  };
});

vi.mock("../dashboard.js", () => ({
  Dashboard: () => null,
  statusLabel: (status: string) => status,
}));

vi.mock("../help-overlay.js", () => ({ HelpOverlay: () => null }));
vi.mock("../settings-overlay.js", () => ({ SettingsOverlay: () => null }));
vi.mock("../approval-overlay.js", () => ({
  ApprovalOverlay: (props: {
    task: { work_description: string; rationale: string; goal_id: string };
    onDecision: (approved: boolean) => void;
  }) => {
    testState.lastApprovalProps = props;
    return null;
  },
}));
vi.mock("../report-view.js", () => ({ ReportView: () => null }));

function createDaemonClientMock() {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    handlers,
    isConnected: vi.fn(() => true),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
    }),
    off: vi.fn((event: string) => {
      handlers.delete(event);
    }),
    connect: vi.fn(),
    disconnect: vi.fn(),
    startGoal: vi.fn(async () => {}),
    stopGoal: vi.fn(async () => {}),
    chat: vi.fn(async () => {}),
    approve: vi.fn(async () => {}),
  };
}

function createStateManagerMock() {
  return {
    listGoalIds: vi.fn(async () => [] as string[]),
    loadGoal: vi.fn(async () => null),
    getBaseDir: vi.fn(() => "/tmp/pulseed-tui-test"),
  };
}

function createChatRunnerMock() {
  return {
    startSession: vi.fn(),
    execute: vi.fn(async () => ({ success: true, output: "", elapsed_ms: 0 })),
    interruptAndRedirect: vi.fn(async () => ({ success: true, output: "", elapsed_ms: 0 })),
    executeIngressMessage: vi.fn(async () => ({ success: true, output: "", elapsed_ms: 0 })),
    onEvent: undefined,
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("formatDaemonConnectionState", () => {
  it("renders connected, connecting, and disconnected labels", () => {
    expect(formatDaemonConnectionState("connected")).toBe("  [daemon connected]");
    expect(formatDaemonConnectionState("connecting")).toBe("  [daemon connecting]");
    expect(formatDaemonConnectionState("disconnected")).toBe("  [daemon disconnected]");
  });

  it("omits the badge when no daemon state is available", () => {
    expect(formatDaemonConnectionState(undefined)).toBeUndefined();
  });
});

describe("standalone slash command routing", () => {
  beforeEach(() => {
    testState.lastChatProps = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes /permissions to ChatRunner instead of standalone intent handlers", async () => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const intentRecognizer = {
      recognize: vi.fn(async () => ({ intent: "unknown", raw: "/permissions" })),
    };
    const actionHandler = {
      handle: vi.fn(async () => ({ messages: ["unexpected"] })),
    };

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      intentRecognizer: intentRecognizer as any,
      actionHandler: actionHandler as any,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("/permissions workspace-write");

    expect(chatRunner.execute).toHaveBeenCalledWith("/permissions workspace-write", "~/workspace");
    expect(intentRecognizer.recognize).not.toHaveBeenCalled();
    expect(actionHandler.handle).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("routes /status to ChatRunner instead of standalone intent handlers", async () => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const intentRecognizer = {
      recognize: vi.fn(async () => ({ intent: "status", raw: "/status" })),
    };
    const actionHandler = {
      handle: vi.fn(async () => ({ messages: ["unexpected"] })),
    };

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      intentRecognizer: intentRecognizer as any,
      actionHandler: actionHandler as any,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("/status");

    expect(chatRunner.execute).toHaveBeenCalledWith("/status", "~/workspace");
    expect(intentRecognizer.recognize).not.toHaveBeenCalled();
    expect(actionHandler.handle).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("routes ChatRunner-only slash commands from the TUI surface", async () => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const intentRecognizer = {
      recognize: vi.fn(async () => ({ intent: "unknown", raw: "/tasks" })),
    };
    const actionHandler = {
      handle: vi.fn(async () => ({ messages: ["unexpected"] })),
    };

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      intentRecognizer: intentRecognizer as any,
      actionHandler: actionHandler as any,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("/tasks goal-1");
    await testState.lastChatProps!.onSubmit("/config");

    expect(chatRunner.execute).toHaveBeenNthCalledWith(1, "/tasks goal-1", "~/workspace");
    expect(chatRunner.execute).toHaveBeenNthCalledWith(2, "/config", "~/workspace");
    expect(intentRecognizer.recognize).not.toHaveBeenCalled();
    expect(actionHandler.handle).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("persists a RunSpec draft and forwards typed metadata for natural-language long-running runs", async () => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "/work/kaggle",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("Run this Kaggle competition until tomorrow morning and aim for top 15%. Keep submissions approval-gated.");

    expect(chatRunner.execute).not.toHaveBeenCalled();
    expect(chatRunner.executeIngressMessage).toHaveBeenCalledOnce();
    const calls = chatRunner.executeIngressMessage.mock.calls as unknown as Array<[
      { metadata: Record<string, unknown> },
      string,
    ]>;
    const [ingress, cwd] = calls[0]!;
    expect(cwd).toBe("/work/kaggle");
    expect(ingress.metadata).toMatchObject({
      run_spec_profile: "kaggle",
      run_spec_status: "draft",
    });
    expect(String(ingress.metadata.run_spec_id)).toMatch(/^runspec-/);

    screen.unmount();
  });

  it("routes input during processing to ChatRunner interrupt redirect", async () => {
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    let resolveExecute: () => void = () => {};
    chatRunner.execute = vi.fn(() => new Promise((resolve) => {
      resolveExecute = () => resolve({ success: true, output: "", elapsed_ms: 0 });
    }));

    const screen = render(React.createElement(App, {
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    const firstSubmit = testState.lastChatProps!.onSubmit("long running task");
    await flush();
    await testState.lastChatProps!.onSubmit("show me the diff first");

    expect(chatRunner.execute).toHaveBeenCalledWith("long running task", "~/workspace");
    expect(chatRunner.interruptAndRedirect).toHaveBeenCalledWith("show me the diff first", "~/workspace");

    resolveExecute();
    await firstSubmit;
    screen.unmount();
  });
});

describe("daemon-mode chat routing", () => {
  beforeEach(() => {
    testState.lastChatProps = null;
    testState.lastApprovalProps = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses ChatRunner when daemon mode has no active goal", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();

    expect(chatRunner.startSession).toHaveBeenCalledWith("~/workspace");
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("free form question");

    expect(chatRunner.execute).toHaveBeenCalledWith("free form question", "~/workspace");
    expect(chatRunner.executeIngressMessage).not.toHaveBeenCalled();
    expect(daemonClient.chat).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("surfaces operator handoffs from daemon events through the approval overlay", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();

    expect(daemonClient.on).toHaveBeenCalledWith("operator_handoff_required", expect.any(Function));
    daemonClient.handlers.get("operator_handoff_required")?.({
      handoff_id: "handoff-1",
      goal_id: "goal-a",
      title: "Deadline handoff",
      summary: "Deadline finalization requires review.",
      recommended_action: "Review final artifact.",
      triggers: ["deadline"],
      created_at: "2026-05-01T00:00:00.000Z",
    });
    await flush();

    expect(testState.lastApprovalProps?.task.work_description).toBe("Deadline handoff");
    expect(testState.lastApprovalProps?.task.rationale).toBe("Deadline finalization requires review.");
    testState.lastApprovalProps?.onDecision(true);

    expect(daemonClient.approve).toHaveBeenCalledWith("goal-a", "handoff-1", true);
    screen.unmount();
  });

  it("keeps free-form text on ChatRunner even when a daemon goal is active", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();

    daemonClient.handlers.get("loop_update")?.({
      goalId: "goal-123",
      running: true,
      iteration: 1,
      status: "running",
      trustScore: 0,
    });
    await flush();

    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("question for the active goal");

    expect(chatRunner.execute).toHaveBeenCalledWith("question for the active goal", "~/workspace");
    expect(daemonClient.chat).not.toHaveBeenCalled();
    expect(chatRunner.executeIngressMessage).not.toHaveBeenCalled();

    screen.unmount();
  });

  it("routes /permissions to ChatRunner in daemon mode", async () => {
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();

    const screen = render(React.createElement(App, {
      daemonClient: daemonClient as unknown as DaemonClient,
      stateManager: stateManager as unknown as StateManager,
      chatRunner: chatRunner as unknown as TuiChatSurface,
      noFlicker: false,
      controlStream: process.stdout,
      cwd: "~/workspace",
      gitBranch: "main",
      providerName: "claude",
    }), {
      patchConsole: false,
      stdout: process.stdout,
      stderr: process.stderr,
    });

    await flush();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("/permissions read-only");

    expect(chatRunner.execute).toHaveBeenCalledWith("/permissions read-only", "~/workspace");
    expect(daemonClient.chat).not.toHaveBeenCalled();

    screen.unmount();
  });
});
