import { describe, expect, it } from "vitest";
import {
  createAgentTimelineActivitySummary,
  projectAgentLoopEventToTimeline,
  summarizeAgentTimelineActivity,
} from "../agent-timeline.js";
import type { AgentLoopEvent } from "../agent-loop-events.js";

function baseEvent(input: Partial<AgentLoopEvent> & { type: AgentLoopEvent["type"]; eventId: string }): AgentLoopEvent {
  return {
    sessionId: "session-1",
    traceId: "trace-1",
    turnId: "turn-1",
    goalId: "goal-1",
    createdAt: "2026-04-08T00:00:00.000Z",
    ...input,
  } as AgentLoopEvent;
}

function finishedTool(
  eventId: string,
  toolName: string,
  inputPreview: string,
  activityCategory?: "search" | "read" | "command" | "file_create" | "file_modify" | "test" | "approval",
): AgentLoopEvent {
  return baseEvent({
    type: "tool_call_finished",
    eventId,
    callId: eventId,
    toolName,
    success: true,
    inputPreview,
    outputPreview: "ok",
    durationMs: 1,
    ...(activityCategory ? { activityCategory } : {}),
  } as Partial<AgentLoopEvent> & { type: AgentLoopEvent["type"]; eventId: string });
}

describe("agent timeline activity summaries", () => {
  it("classifies structured activity deterministically", () => {
    const items = [
      finishedTool("search-1", "shell_command", JSON.stringify({ command: "rg ChatRunner src/interface/chat" })),
      finishedTool("read-1", "read_file", JSON.stringify({ path: "src/interface/chat/chat-runner.ts" }), "read"),
      finishedTool("command-1", "shell_command", JSON.stringify({ command: "node scripts/build.js" })),
      finishedTool("create-1", "file_write", JSON.stringify({ path: "src/new-file.ts" }), "file_create"),
      finishedTool("modify-1", "apply_patch", JSON.stringify({ path: "src/existing.ts" }), "file_modify"),
      finishedTool("test-1", "shell_command", JSON.stringify({ command: "npm run typecheck" })),
      baseEvent({
        type: "approval_request",
        eventId: "approval-1",
        callId: "approval-1",
        toolName: "apply_patch",
        reason: "modify src/existing.ts",
        permissionLevel: "workspace-write",
        isDestructive: false,
      }),
    ].map(projectAgentLoopEventToTimeline);

    expect(summarizeAgentTimelineActivity(items)).toEqual([
      { kind: "search", count: 1 },
      { kind: "read", count: 1 },
      { kind: "command", count: 1 },
      { kind: "file_create", count: 1 },
      { kind: "file_modify", count: 1 },
      { kind: "test", count: 1 },
      { kind: "approval", count: 1 },
    ]);
  });

  it("prefers declared tool metadata over tool-name substrings", () => {
    const items = [
      finishedTool("metadata-1", "search_like_name", JSON.stringify({ path: "src/created.ts" }), "file_create"),
      finishedTool("metadata-2", "verify_like_name", JSON.stringify({ path: "src/read.ts" }), "read"),
    ].map(projectAgentLoopEventToTimeline);

    expect(summarizeAgentTimelineActivity(items)).toEqual([
      { kind: "read", count: 1 },
      { kind: "file_create", count: 1 },
    ]);
  });

  it("uses shell command parsing for explicit command protocol input", () => {
    const items = [
      finishedTool("shell-search", "shell_command", JSON.stringify({ command: "rg Timeline src" }), "command"),
      finishedTool("shell-test", "shell_command", JSON.stringify({ command: "npm run test:changed" }), "command"),
    ].map(projectAgentLoopEventToTimeline);

    expect(summarizeAgentTimelineActivity(items)).toEqual([
      { kind: "search", count: 1 },
      { kind: "test", count: 1 },
    ]);
  });

  it("keeps unknown tool fallback conservative", () => {
    const items = [
      finishedTool("unknown-1", "mystery_search_writer", JSON.stringify({ path: "src/file.ts" })),
    ].map(projectAgentLoopEventToTimeline);

    expect(summarizeAgentTimelineActivity(items)).toEqual([
      { kind: "command", count: 1 },
    ]);
  });

  it("projects full typed tool observations for display-layer consumers", () => {
    const item = projectAgentLoopEventToTimeline(baseEvent({
      type: "tool_observation",
      eventId: "observation-1",
      observation: {
        type: "tool_observation",
        callId: "call-1",
        toolName: "shell_command",
        arguments: { command: "echo ok" },
        state: "success",
        success: true,
        execution: { status: "executed" },
        durationMs: 5,
        output: {
          content: "Command succeeded",
          summary: "Command succeeded",
          data: { stdout: "ok\n", stderr: "", exitCode: 0 },
        },
        command: "echo ok",
        cwd: "/repo",
        activityCategory: "command",
      },
    }));

    expect(item).toMatchObject({
      kind: "tool_observation",
      visibility: "debug",
      callId: "call-1",
      toolName: "shell_command",
      observation: {
        type: "tool_observation",
        arguments: { command: "echo ok" },
        execution: { status: "executed" },
        output: {
          data: { stdout: "ok\n", stderr: "", exitCode: 0 },
        },
      },
    });
  });

  it("makes denied typed tool observations user visible without relying on text matching", () => {
    const item = projectAgentLoopEventToTimeline(baseEvent({
      type: "tool_observation",
      eventId: "observation-denied-1",
      observation: {
        type: "tool_observation",
        callId: "call-denied",
        toolName: "apply_patch",
        arguments: { path: "src/example.ts" },
        state: "denied",
        success: false,
        execution: {
          status: "not_executed",
          reason: "approval_denied",
          message: "Write access was denied.",
        },
        durationMs: 5,
        output: {
          content: "TOOL NOT EXECUTED (approval_denied): Write access was denied.",
        },
        activityCategory: "file_modify",
      },
    }));

    expect(item).toMatchObject({
      kind: "tool_observation",
      visibility: "user",
      state: "denied",
      observation: {
        execution: {
          status: "not_executed",
          reason: "approval_denied",
        },
      },
    });
  });

  it("creates a shared summary item separate from detailed timeline items", () => {
    const items = [
      finishedTool("search-1", "shell_command", JSON.stringify({ command: "rg Timeline src" })),
      finishedTool("command-1", "shell_command", JSON.stringify({ command: "node scripts/build.js" })),
    ].map(projectAgentLoopEventToTimeline);

    const summary = createAgentTimelineActivitySummary({
      id: "agent-timeline:summary-1",
      sourceEventId: "summary-1",
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "turn-1",
      goalId: "goal-1",
      createdAt: "2026-04-08T00:00:10.000Z",
      items,
    });

    expect(summary).toMatchObject({
      kind: "activity_summary",
      text: "searched 1 search, ran 1 command",
      buckets: [
        { kind: "search", count: 1 },
        { kind: "command", count: 1 },
      ],
    });
    expect(items).toHaveLength(2);
  });
});
