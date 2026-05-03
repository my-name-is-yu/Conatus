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

function finishedTool(eventId: string, toolName: string, inputPreview: string): AgentLoopEvent {
  return baseEvent({
    type: "tool_call_finished",
    eventId,
    callId: eventId,
    toolName,
    success: true,
    inputPreview,
    outputPreview: "ok",
    durationMs: 1,
  } as Partial<AgentLoopEvent> & { type: AgentLoopEvent["type"]; eventId: string });
}

describe("agent timeline activity summaries", () => {
  it("classifies structured activity deterministically", () => {
    const items = [
      finishedTool("search-1", "shell_command", JSON.stringify({ command: "rg ChatRunner src/interface/chat" })),
      finishedTool("read-1", "read_file", JSON.stringify({ path: "src/interface/chat/chat-runner.ts" })),
      finishedTool("command-1", "shell_command", JSON.stringify({ command: "node scripts/build.js" })),
      finishedTool("create-1", "file_write", JSON.stringify({ path: "src/new-file.ts" })),
      finishedTool("modify-1", "apply_patch", JSON.stringify({ path: "src/existing.ts" })),
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
