import { describe, expect, it } from "vitest";
import { applyChatEventToMessages } from "../chat-event-state.js";
import { ChatRunnerEventBridge } from "../chat-runner-event-bridge.js";
import type { ChatEvent } from "../chat-events.js";
import { classifyFailureRecovery } from "../failure-recovery.js";

describe("applyChatEventToMessages", () => {
  it("keeps activity as one updatable row per turn", () => {
    const first = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "lifecycle",
      message: "Received. Starting work...",
      sourceId: "lifecycle:start",
      transient: true,
    }, 20);

    const second = applyChatEventToMessages(first, {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      kind: "tool",
      message: "Running tool: grep - ChatEvent",
      sourceId: "tool-1",
      transient: true,
    }, 20);

    expect(second).toHaveLength(1);
    expect(second[0]!).toMatchObject({
      id: "activity:turn-1",
      role: "pulseed",
      text: "Running tool: grep - ChatEvent",
      messageType: "info",
    });
  });

  it("shows raw tool events without current/recent activity headings", () => {
    const messages = applyChatEventToMessages([], {
      type: "tool_start",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      toolCallId: "tool-1",
      toolName: "shell_command",
      args: { command: "rg ChatEvent src/interface/chat", cwd: "/repo" },
    }, 20);

    expect(messages).toHaveLength(1);
    expect(messages[0]!).toMatchObject({
      id: "tool-log:turn-1",
      role: "pulseed",
      messageType: "info",
    });
    expect(messages[0]!.text).not.toContain("Current activity");
    expect(messages[0]!.text).not.toContain("Recent activity");
    expect(messages[0]!.text).toContain("Reading shell_command - command=rg ChatEvent src/interface/chat");
  });

  it("renders shared agent timeline items as chronological chat messages", () => {
    const base = {
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
    };
    const timelineBase = {
      sourceEventId: "event-1",
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "agent-turn-1",
      goalId: "goal-1",
      visibility: "user" as const,
    };
    const events = [
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:commentary-1",
          sourceEventId: "commentary-1",
          sourceType: "assistant_message" as const,
          createdAt: "2026-04-08T00:00:01.000Z",
          kind: "assistant_message" as const,
          phase: "commentary" as const,
          text: "I will inspect the relevant files first.",
          toolCallCount: 1,
        },
      },
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:tool-start-1",
          sourceEventId: "tool-start-1",
          sourceType: "tool_call_started" as const,
          createdAt: "2026-04-08T00:00:02.000Z",
          kind: "tool" as const,
          status: "started" as const,
          callId: "call-1",
          toolName: "shell_command",
          inputPreview: "{\"command\":\"pwd\"}",
        },
      },
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:tool-finish-1",
          sourceEventId: "tool-finish-1",
          sourceType: "tool_call_finished" as const,
          createdAt: "2026-04-08T00:00:03.000Z",
          kind: "tool" as const,
          status: "finished" as const,
          callId: "call-1",
          toolName: "shell_command",
          success: true,
          outputPreview: "/repo",
          durationMs: 10,
        },
      },
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:final-1",
          sourceEventId: "final-1",
          sourceType: "final" as const,
          createdAt: "2026-04-08T00:00:04.000Z",
          kind: "final" as const,
          success: true,
          outputPreview: "Done",
        },
      },
    ];

    const messages = events.reduce(
      (current, event) => applyChatEventToMessages(current, event, 20),
      [] as ReturnType<typeof applyChatEventToMessages>
    );

    expect(messages.map((message) => message.id)).toEqual([
      "agent-timeline:turn-1:commentary-1",
      "agent-timeline:turn-1:tool-start-1",
      "agent-timeline:turn-1:tool-finish-1",
      "agent-timeline:turn-1:final-1",
    ]);
    expect(messages.map((message) => message.text)).toEqual([
      "I will inspect the relevant files first.",
      "Started shell_command: {\"command\":\"pwd\"}",
      "Finished shell_command: /repo",
      "Done",
    ]);

    const afterFinal = applyChatEventToMessages(messages, {
      type: "assistant_final",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:05.000Z",
      text: "Done",
      persisted: true,
    }, 20);

    expect(afterFinal.map((message) => message.id)).toEqual([
      "agent-timeline:turn-1:commentary-1",
      "agent-timeline:turn-1:tool-start-1",
      "agent-timeline:turn-1:tool-finish-1",
      "turn-1",
    ]);
    expect(afterFinal.at(-1)!.text).toBe("Done");
  });

  it("drops transient timeline overflow before evicting durable chat messages", () => {
    let messages = applyChatEventToMessages([], {
      type: "assistant_final",
      runId: "run-1",
      turnId: "older-turn",
      createdAt: "2026-04-08T00:00:00.000Z",
      text: "Earlier durable answer",
      persisted: true,
    }, 3);

    for (let index = 1; index <= 4; index += 1) {
      messages = applyChatEventToMessages(messages, {
        type: "agent_timeline",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: `2026-04-08T00:00:0${index}.000Z`,
        item: {
          id: `agent-timeline:final-${index}`,
          sourceEventId: `final-${index}`,
          sourceType: "final",
          sessionId: "session-1",
          traceId: "trace-1",
          turnId: "agent-turn-1",
          goalId: "goal-1",
          createdAt: `2026-04-08T00:00:0${index}.000Z`,
          visibility: "user",
          kind: "final",
          success: true,
          outputPreview: `Candidate final ${index}`,
        },
      }, 3);
    }

    expect(messages.some((message) => message.id === "older-turn")).toBe(true);
    expect(messages).toHaveLength(3);
    expect(messages.filter((message) => message.transient)).toHaveLength(2);
  });

  it("preserves agent commentary around tool work through the shared timeline caller path", async () => {
    const events: ChatEvent[] = [];
    const bridge = new ChatRunnerEventBridge(() => (event) => {
      events.push(event);
    });
    const context = { runId: "run-1", turnId: "turn-1" };
    const sink = bridge.createAgentLoopEventSink(context);
    const base = {
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "agent-turn-1",
      goalId: "goal-1",
      createdAt: "2026-04-08T00:00:00.000Z",
    };

    await sink.emit({
      ...base,
      type: "assistant_message",
      eventId: "commentary-1",
      phase: "commentary",
      contentPreview: "I will inspect the entrypoint first.",
      toolCallCount: 1,
    });
    await sink.emit({
      ...base,
      type: "tool_call_started",
      eventId: "tool-start-1",
      callId: "call-1",
      toolName: "shell_command",
      inputPreview: "{\"command\":\"rg ChatRunner src/interface/chat\"}",
    });
    await sink.emit({
      ...base,
      type: "tool_call_finished",
      eventId: "tool-finish-1",
      callId: "call-1",
      toolName: "shell_command",
      success: true,
      outputPreview: "src/interface/chat/chat-runner.ts",
      durationMs: 12,
    });
    await sink.emit({
      ...base,
      type: "assistant_message",
      eventId: "commentary-2",
      phase: "commentary",
      contentPreview: "I found the bridge path, so I will update the contract test next.",
      toolCallCount: 0,
    });
    await sink.emit({
      ...base,
      type: "final",
      eventId: "final-1",
      success: true,
      outputPreview: "Done",
    });

    const messages = events.reduce(
      (current, event) => applyChatEventToMessages(current, event, 20),
      [] as ReturnType<typeof applyChatEventToMessages>
    );
    const timelineMessages = messages.filter((message) => message.id.startsWith("agent-timeline:turn-1:"));

    expect(timelineMessages.map((message) => message.text)).toEqual([
      "I will inspect the entrypoint first.",
      "Started shell_command: {\"command\":\"rg ChatRunner src/interface/chat\"}",
      "Finished shell_command: src/interface/chat/chat-runner.ts",
      "I found the bridge path, so I will update the contract test next.",
      "Done",
    ]);
  });

  it("renders shared timeline tool and approval rows chronologically without a latest-five cap", () => {
    const base = {
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
    };
    const timelineBase = {
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "agent-turn-1",
      goalId: "goal-1",
      visibility: "user" as const,
    };
    const events = [
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:commentary-1",
          sourceEventId: "commentary-1",
          sourceType: "assistant_message" as const,
          createdAt: "2026-04-08T00:00:01.000Z",
          kind: "assistant_message" as const,
          phase: "commentary" as const,
          text: "I will inspect the files first.",
          toolCallCount: 6,
        },
      },
      ...Array.from({ length: 6 }, (_, offset) => {
        const index = offset + 1;
        return {
          type: "agent_timeline" as const,
          ...base,
          item: {
            ...timelineBase,
            id: `agent-timeline:tool-start-${index}`,
            sourceEventId: `tool-start-${index}`,
            sourceType: "tool_call_started" as const,
            createdAt: `2026-04-08T00:00:0${index + 1}.000Z`,
            kind: "tool" as const,
            status: "started" as const,
            callId: `call-${index}`,
            toolName: "read_file",
            inputPreview: `src/file-${index}.ts`,
          },
        };
      }),
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:approval-1",
          sourceEventId: "approval-1",
          sourceType: "approval_request" as const,
          createdAt: "2026-04-08T00:00:08.000Z",
          kind: "approval" as const,
          status: "requested" as const,
          callId: "call-approval",
          toolName: "apply_patch",
          reason: "modify src/example.ts",
          permissionLevel: "workspace-write",
          isDestructive: false,
        },
      },
      {
        type: "agent_timeline" as const,
        ...base,
        item: {
          ...timelineBase,
          id: "agent-timeline:final-1",
          sourceEventId: "final-1",
          sourceType: "final" as const,
          createdAt: "2026-04-08T00:00:09.000Z",
          kind: "final" as const,
          success: true,
          outputPreview: "Done",
        },
      },
    ];

    const messages = events.reduce(
      (current, event) => applyChatEventToMessages(current, event, 20),
      [] as ReturnType<typeof applyChatEventToMessages>
    );

    expect(messages.map((message) => message.text)).toEqual([
      "I will inspect the files first.",
      "Started read_file: src/file-1.ts",
      "Started read_file: src/file-2.ts",
      "Started read_file: src/file-3.ts",
      "Started read_file: src/file-4.ts",
      "Started read_file: src/file-5.ts",
      "Started read_file: src/file-6.ts",
      "Approval requested for apply_patch: modify src/example.ts",
      "Done",
    ]);
    expect(messages.map((message) => message.text).join("\n")).not.toContain("Current activity");
    expect(messages.map((message) => message.text).join("\n")).not.toContain("Recent activity");
  });

  it("keeps shared timeline rendering compatible when no commentary is emitted", async () => {
    const events: ChatEvent[] = [];
    const bridge = new ChatRunnerEventBridge(() => (event) => {
      events.push(event);
    });
    const sink = bridge.createAgentLoopEventSink({ runId: "run-1", turnId: "turn-1" });
    const base = {
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "agent-turn-1",
      goalId: "goal-1",
      createdAt: "2026-04-08T00:00:00.000Z",
    };

    await sink.emit({
      ...base,
      type: "tool_call_started",
      eventId: "tool-start-1",
      callId: "call-1",
      toolName: "shell_command",
      inputPreview: "{\"command\":\"pwd\"}",
    });
    await sink.emit({
      ...base,
      type: "final",
      eventId: "final-1",
      success: true,
      outputPreview: "Done",
    });

    const messages = events.reduce(
      (current, event) => applyChatEventToMessages(current, event, 20),
      [] as ReturnType<typeof applyChatEventToMessages>
    );

    expect(messages.map((message) => message.text)).toContain("Started shell_command: {\"command\":\"pwd\"}");
    expect(messages.map((message) => message.text)).toContain("Done");
  });

  it("removes transient activity when assistant final arrives", () => {
    const withActivity = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "lifecycle",
      message: "Working...",
      transient: true,
    }, 20);

    const afterFinal = applyChatEventToMessages(withActivity, {
      type: "assistant_final",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      text: "Done",
      persisted: true,
    }, 20);

    expect(afterFinal).toHaveLength(1);
    expect(afterFinal[0]!.id).toBe("turn-1");
    expect(afterFinal[0]!.text).toBe("Done");
  });

  it("removes transient activity when lifecycle error arrives", () => {
    const withActivity = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "tool",
      message: "Running tool...",
      transient: true,
    }, 20);

    const afterError = applyChatEventToMessages(withActivity, {
      type: "lifecycle_error",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      error: "boom",
      partialText: "Partial",
      persisted: false,
      recovery: classifyFailureRecovery("boom"),
    }, 20);

    expect(afterError).toHaveLength(1);
    expect(afterError[0]!.id).toBe("turn-1");
    expect(afterError[0]!.messageType).toBe("error");
    expect(afterError[0]!.text).toContain("Recovery");
    expect(afterError[0]!.text).toContain("Next actions");
  });

  it("removes transient activity on lifecycle end", () => {
    const withActivity = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "commentary",
      message: "Still working...",
      transient: true,
    }, 20);

    const afterEnd = applyChatEventToMessages(withActivity, {
      type: "lifecycle_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:02.000Z",
      status: "completed",
      elapsedMs: 2000,
      persisted: true,
    }, 20);

    expect(afterEnd).toEqual([]);
  });

  it("keeps non-transient activity rows after turn-ending events", () => {
    const withPersistentActivity = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "commentary",
      message: "Pinned note",
      transient: false,
    }, 20);

    const afterEnd = applyChatEventToMessages(withPersistentActivity, {
      type: "lifecycle_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      status: "completed",
      elapsedMs: 1000,
      persisted: true,
    }, 20);

    expect(afterEnd).toHaveLength(1);
    expect(afterEnd[0]!.id).toBe("activity:turn-1");
    expect(afterEnd[0]!.text).toBe("Pinned note");
  });

  it("keeps non-transient sourced activity separate from transient status updates", () => {
    const withIntent = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "commentary",
      message: "Intent\n- Confirm: inspect the repo",
      sourceId: "intent:first-step",
      transient: false,
    }, 20);

    const withStatus = applyChatEventToMessages(withIntent, {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      kind: "lifecycle",
      message: "Preparing context...",
      sourceId: "lifecycle:context",
      transient: true,
    }, 20);

    const afterEnd = applyChatEventToMessages(withStatus, {
      type: "lifecycle_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:02.000Z",
      status: "completed",
      elapsedMs: 2000,
      persisted: true,
    }, 20);

    expect(afterEnd).toHaveLength(1);
    expect(afterEnd[0]!).toMatchObject({
      id: "activity:turn-1:intent:first-step",
      text: "Intent\n- Confirm: inspect the repo",
      transient: false,
    });
  });

  it("keeps checkpoint rows visible after transient lifecycle activity ends", () => {
    const withCheckpoint = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "checkpoint",
      message: "Checkpoint\n- Context gathered: Workspace grounding is ready.",
      sourceId: "checkpoint:context",
      transient: false,
    }, 20);

    const withStatus = applyChatEventToMessages(withCheckpoint, {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      kind: "lifecycle",
      message: "Calling adapter...",
      sourceId: "lifecycle:adapter",
      transient: true,
    }, 20);

    const afterEnd = applyChatEventToMessages(withStatus, {
      type: "lifecycle_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:02.000Z",
      status: "completed",
      elapsedMs: 2000,
      persisted: true,
    }, 20);

    expect(afterEnd).toHaveLength(1);
    expect(afterEnd[0]!).toMatchObject({
      id: "activity:turn-1:checkpoint:context",
      text: "Checkpoint\n- Context gathered: Workspace grounding is ready.",
      transient: false,
    });
  });

  it("keeps diff artifact rows visible after transient lifecycle activity ends", () => {
    const withDiff = applyChatEventToMessages([], {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      kind: "diff",
      message: "Changed files\nModified files\nM\tsrc/example.ts",
      sourceId: "diff:working-tree",
      transient: false,
    }, 20);

    const withStatus = applyChatEventToMessages(withDiff, {
      type: "activity",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      kind: "lifecycle",
      message: "Finalizing response...",
      sourceId: "lifecycle:finalizing",
      transient: true,
    }, 20);

    const afterEnd = applyChatEventToMessages(withStatus, {
      type: "lifecycle_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:02.000Z",
      status: "completed",
      elapsedMs: 2000,
      persisted: true,
    }, 20);

    expect(afterEnd).toHaveLength(1);
    expect(afterEnd[0]!).toMatchObject({
      id: "activity:turn-1:diff:working-tree",
      text: "Changed files\nModified files\nM\tsrc/example.ts",
      transient: false,
    });
  });

  it("keeps all raw tool activities visible without current/recent headings", () => {
    let messages = [] as ReturnType<typeof applyChatEventToMessages>;
    for (let index = 1; index <= 6; index += 1) {
      messages = applyChatEventToMessages(messages, {
        type: "tool_start",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: `2026-04-08T00:00:0${index}.000Z`,
        toolCallId: `tool-${index}`,
        toolName: "read_file",
        args: { path: `src/file-${index}.ts` },
      }, 20);
    }

    const toolLog = messages.find((message) => message.id === "tool-log:turn-1");
    expect(toolLog?.text).toContain("file-1.ts");
    expect(toolLog?.text).toContain("file-2.ts");
    expect(toolLog?.text).toContain("file-6.ts");
    expect(toolLog?.text).not.toContain("Current activity");
    expect(toolLog?.text).not.toContain("Recent activity");

    const afterEnd = applyChatEventToMessages(messages, {
      type: "lifecycle_end",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:10.000Z",
      status: "completed",
      elapsedMs: 10_000,
      persisted: true,
    }, 20);

    expect(afterEnd.find((message) => message.id === "tool-log:turn-1")?.text).not.toContain("Recent activity");
    expect(afterEnd.find((message) => message.id === "tool-log:turn-1")?.text).toContain("file-1.ts");
  });

  it("keeps tool intent categories across updates and distinguishes waiting for approval", () => {
    const started = applyChatEventToMessages([], {
      type: "tool_start",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      toolCallId: "tool-1",
      toolName: "shell_command",
      args: { command: "npm run test:changed -- --run" },
    }, 20);

    const running = applyChatEventToMessages(started, {
      type: "tool_update",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      toolCallId: "tool-1",
      toolName: "shell_command",
      status: "running",
      message: "running",
    }, 20);

    expect(running[0]!.text).toContain("Verifying shell_command");
    expect(running[0]!.text).toContain("command=npm run test:changed -- --run");

    const waiting = applyChatEventToMessages(running, {
      type: "tool_update",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:02.000Z",
      toolCallId: "tool-2",
      toolName: "apply_patch",
      status: "awaiting_approval",
      message: "write src/example.ts",
    }, 20);

    expect(waiting[0]!.text).toContain("Waiting for approval apply_patch - write src/example.ts");
  });

  it("moves a tool out of waiting once execution resumes after approval", () => {
    const waiting = applyChatEventToMessages([], {
      type: "tool_update",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:00.000Z",
      toolCallId: "tool-1",
      toolName: "apply_patch",
      status: "awaiting_approval",
      message: "write src/example.ts",
    }, 20);

    const running = applyChatEventToMessages(waiting, {
      type: "tool_update",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-04-08T00:00:01.000Z",
      toolCallId: "tool-1",
      toolName: "apply_patch",
      status: "running",
      message: "running",
    }, 20);

    expect(running[0]!.text).not.toContain("Waiting for approval apply_patch");
    expect(running[0]!.text).toContain("Editing apply_patch - write src/example.ts");
  });
});
