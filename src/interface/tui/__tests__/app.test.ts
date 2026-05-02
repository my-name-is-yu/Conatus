import React, { act } from "react";
import { render } from "ink";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../../../runtime/daemon/client.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { TuiChatSurface } from "../chat-surface.js";
import { App, DASHBOARD_REFRESH_INTERVAL_MS, formatDaemonConnectionState } from "../app.js";

const testState = vi.hoisted(() => ({
  lastChatProps: null as null | { onSubmit: (value: string) => Promise<void> },
  lastApprovalProps: null as null | {
    task: { work_description: string; rationale: string; goal_id: string };
    onDecision: (approved: boolean) => void;
  },
  lastDashboardProps: null as null | Record<string, unknown>,
  runtimeSessionSnapshots: [] as Array<Record<string, unknown>>,
  runtimeSessionSnapshotCalls: 0,
  summarizedRunIds: [] as string[],
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

vi.mock("../dashboard.js", async () => {
  const actual = await vi.importActual<typeof import("../dashboard.js")>("../dashboard.js");
  return {
    ...actual,
    Dashboard: (props: Record<string, unknown>) => {
      testState.lastDashboardProps = props;
      return null;
    },
    statusLabel: (status: string) => status,
  };
});

vi.mock("../../../runtime/session-registry/index.js", () => ({
  createRuntimeSessionRegistry: () => ({
    snapshot: vi.fn(async () => {
      const index = Math.min(
        testState.runtimeSessionSnapshotCalls,
        Math.max(0, testState.runtimeSessionSnapshots.length - 1),
      );
      testState.runtimeSessionSnapshotCalls += 1;
      return testState.runtimeSessionSnapshots[index] ?? null;
    }),
  }),
}));

vi.mock("../../../runtime/store/health-store.js", () => ({
  RuntimeHealthStore: class {
    loadSnapshot = vi.fn(async () => null);
  },
}));

vi.mock("../../../runtime/store/evidence-ledger.js", () => ({
  RuntimeEvidenceLedger: class {
    summarizeRun = vi.fn(async (runId: string) => {
      testState.summarizedRunIds.push(runId);
      return null;
    });
  },
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
    getConversationId: vi.fn(() => "tui-conversation-test"),
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
    vi.useRealTimers();
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

  it("persists a RunSpec draft and waits for confirmation before forwarding long-running runs", async () => {
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
    expect(chatRunner.executeIngressMessage).not.toHaveBeenCalled();

    await flush();
    await testState.lastChatProps!.onSubmit("confirm");

    expect(chatRunner.executeIngressMessage).toHaveBeenCalledOnce();
    const calls = chatRunner.executeIngressMessage.mock.calls as unknown as Array<[
      { metadata: Record<string, unknown> },
      string,
    ]>;
    const [ingress, cwd] = calls[0]!;
    expect(cwd).toBe("/work/kaggle");
    expect(ingress.metadata).toMatchObject({
      run_spec_profile: "kaggle",
      run_spec_status: "confirmed",
    });
    expect(String(ingress.metadata.run_spec_id)).toMatch(/^runspec-/);

    screen.unmount();
  });

  it("does not start a long-running run when required RunSpec fields remain unresolved", async () => {
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

    await testState.lastChatProps!.onSubmit("Run this Kaggle competition and aim for top 15%. Keep submissions approval-gated.");
    await flush();
    await testState.lastChatProps!.onSubmit("confirm");

    expect(chatRunner.execute).not.toHaveBeenCalled();
    expect(chatRunner.executeIngressMessage).not.toHaveBeenCalled();

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
    testState.lastDashboardProps = null;
    testState.runtimeSessionSnapshots = [];
    testState.runtimeSessionSnapshotCalls = 0;
    testState.summarizedRunIds = [];
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("refreshes runtime session snapshots while the dashboard remains open", async () => {
    vi.useFakeTimers();
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    testState.runtimeSessionSnapshots = [
      {
        schema_version: "runtime-session-registry-v1",
        generated_at: "2026-05-02T00:00:00.000Z",
        sessions: [],
        background_runs: [],
        warnings: [],
      },
      {
        schema_version: "runtime-session-registry-v1",
        generated_at: "2026-05-02T00:00:05.000Z",
        sessions: [],
        background_runs: [{
          schema_version: "background-run-v1",
          id: "run-refresh",
          kind: "coreloop_run",
          parent_session_id: null,
          child_session_id: null,
          process_session_id: null,
          status: "running",
          notify_policy: "done_only",
          reply_target_source: "none",
          pinned_reply_target: null,
          title: "Refreshed work",
          workspace: "/repo",
          created_at: "2026-05-02T00:00:00.000Z",
          started_at: "2026-05-02T00:00:00.000Z",
          updated_at: "2026-05-02T00:00:05.000Z",
          completed_at: null,
          summary: null,
          error: null,
          artifacts: [],
          source_refs: [],
        }],
        warnings: [],
      },
    ];

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

    await vi.runOnlyPendingTimersAsync();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("/dashboard");
    await vi.runOnlyPendingTimersAsync();

    expect(testState.lastDashboardProps?.runtimeSessions).toMatchObject({
      generated_at: "2026-05-02T00:00:00.000Z",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DASHBOARD_REFRESH_INTERVAL_MS + 1);
    });

    expect(testState.runtimeSessionSnapshotCalls).toBeGreaterThanOrEqual(2);
    expect(testState.lastDashboardProps?.runtimeSessions).toMatchObject({
      generated_at: "2026-05-02T00:00:05.000Z",
      background_runs: [expect.objectContaining({ id: "run-refresh" })],
    });

    screen.unmount();
    vi.useRealTimers();
  });

  it("loads evidence summaries for dashboard-selected runs instead of raw snapshot head", async () => {
    vi.useFakeTimers();
    const daemonClient = createDaemonClientMock();
    const stateManager = createStateManagerMock();
    const chatRunner = createChatRunnerMock();
    const now = new Date().toISOString();
    const completedRuns = Array.from({ length: 9 }, (_, index) => ({
      schema_version: "background-run-v1",
      id: `run-completed-${index}`,
      kind: "coreloop_run",
      parent_session_id: null,
      child_session_id: null,
      process_session_id: null,
      status: "succeeded",
      notify_policy: "done_only",
      reply_target_source: "none",
      pinned_reply_target: null,
      title: `Completed ${index}`,
      workspace: "/repo",
      created_at: now,
      started_at: now,
      updated_at: now,
      completed_at: now,
      summary: null,
      error: null,
      artifacts: [],
      source_refs: [],
    }));
    testState.runtimeSessionSnapshots = [{
      schema_version: "runtime-session-registry-v1",
      generated_at: now,
      sessions: [],
      background_runs: [
        ...completedRuns,
        {
          schema_version: "background-run-v1",
          id: "run-active-selected",
          kind: "coreloop_run",
          parent_session_id: null,
          child_session_id: null,
          process_session_id: null,
          status: "running",
          notify_policy: "done_only",
          reply_target_source: "none",
          pinned_reply_target: null,
          title: "Active selected run",
          workspace: "/repo",
          created_at: now,
          started_at: now,
          updated_at: now,
          completed_at: null,
          summary: null,
          error: null,
          artifacts: [],
          source_refs: [],
        },
      ],
      warnings: [],
    }];

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

    await vi.runOnlyPendingTimersAsync();
    expect(testState.lastChatProps).not.toBeNull();

    await testState.lastChatProps!.onSubmit("/dashboard");
    await vi.runOnlyPendingTimersAsync();

    expect(testState.summarizedRunIds).toContain("run-active-selected");

    screen.unmount();
    vi.useRealTimers();
  });
});
