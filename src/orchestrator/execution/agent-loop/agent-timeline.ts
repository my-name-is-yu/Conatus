import type { AgentLoopEvent } from "./agent-loop-events.js";

export type AgentTimelineItem =
  | AgentTimelineLifecycleItem
  | AgentTimelineTurnContextItem
  | AgentTimelineModelRequestItem
  | AgentTimelineAssistantMessageItem
  | AgentTimelineToolItem
  | AgentTimelinePlanItem
  | AgentTimelineApprovalItem
  | AgentTimelineCompactionItem
  | AgentTimelineFinalItem
  | AgentTimelineStoppedItem;

export interface AgentTimelineBaseItem {
  id: string;
  sourceEventId: string;
  sourceType: AgentLoopEvent["type"];
  sessionId: string;
  traceId: string;
  turnId: string;
  goalId: string;
  taskId?: string;
  createdAt: string;
  visibility: "user" | "debug";
}

export interface AgentTimelineLifecycleItem extends AgentTimelineBaseItem {
  kind: "lifecycle";
  status: "started" | "resumed";
  restoredMessages?: number;
  fromUpdatedAt?: string;
}

export interface AgentTimelineTurnContextItem extends AgentTimelineBaseItem {
  kind: "turn_context";
  cwd: string;
  model: string;
  visibleTools: string[];
}

export interface AgentTimelineModelRequestItem extends AgentTimelineBaseItem {
  kind: "model_request";
  model: string;
  toolCount: number;
}

export interface AgentTimelineAssistantMessageItem extends AgentTimelineBaseItem {
  kind: "assistant_message";
  phase: "commentary" | "final_candidate";
  text: string;
  toolCallCount: number;
}

export interface AgentTimelineToolItem extends AgentTimelineBaseItem {
  kind: "tool";
  status: "started" | "finished";
  callId: string;
  toolName: string;
  inputPreview?: string;
  success?: boolean;
  disposition?: "respond_to_model" | "fatal" | "approval_denied" | "cancelled";
  outputPreview?: string;
  durationMs?: number;
  artifacts?: string[];
  truncated?: {
    originalChars: number;
    overflowPath?: string;
  };
}

export interface AgentTimelinePlanItem extends AgentTimelineBaseItem {
  kind: "plan";
  summary: string;
}

export interface AgentTimelineApprovalItem extends AgentTimelineBaseItem {
  kind: "approval";
  status: "requested" | "denied";
  callId?: string;
  toolName: string;
  reason: string;
  permissionLevel?: string;
  isDestructive?: boolean;
}

export interface AgentTimelineCompactionItem extends AgentTimelineBaseItem {
  kind: "compaction";
  phase: "pre_turn" | "mid_turn" | "standalone_turn";
  reason: "context_limit" | "model_downshift" | "manual";
  inputMessages: number;
  outputMessages: number;
  summaryPreview: string;
}

export interface AgentTimelineFinalItem extends AgentTimelineBaseItem {
  kind: "final";
  success: boolean;
  outputPreview: string;
}

export interface AgentTimelineStoppedItem extends AgentTimelineBaseItem {
  kind: "stopped";
  reason: string;
  reasonDetail?: string;
}

export function projectAgentLoopEventToTimeline(event: AgentLoopEvent): AgentTimelineItem {
  const base = {
    id: `agent-timeline:${event.eventId}`,
    sourceEventId: event.eventId,
    sourceType: event.type,
    sessionId: event.sessionId,
    traceId: event.traceId,
    turnId: event.turnId,
    goalId: event.goalId,
    ...(event.taskId ? { taskId: event.taskId } : {}),
    createdAt: event.createdAt,
    visibility: "user" as const,
  };

  switch (event.type) {
    case "started":
      return { ...base, kind: "lifecycle", status: "started" };
    case "resumed":
      return {
        ...base,
        kind: "lifecycle",
        status: "resumed",
        restoredMessages: event.restoredMessages,
        fromUpdatedAt: event.fromUpdatedAt,
      };
    case "turn_context":
      return {
        ...base,
        kind: "turn_context",
        cwd: event.cwd,
        model: event.model,
        visibleTools: event.visibleTools,
      };
    case "model_request":
      return {
        ...base,
        kind: "model_request",
        model: event.model,
        toolCount: event.toolCount,
      };
    case "assistant_message":
      return {
        ...base,
        kind: "assistant_message",
        phase: event.phase,
        text: event.contentPreview,
        toolCallCount: event.toolCallCount,
      };
    case "tool_call_started":
      return {
        ...base,
        kind: "tool",
        status: "started",
        callId: event.callId,
        toolName: event.toolName,
        inputPreview: event.inputPreview,
      };
    case "tool_call_finished":
      return {
        ...base,
        kind: "tool",
        status: "finished",
        callId: event.callId,
        toolName: event.toolName,
        success: event.success,
        ...(event.disposition ? { disposition: event.disposition } : {}),
        outputPreview: event.outputPreview,
        durationMs: event.durationMs,
        ...(event.artifacts ? { artifacts: event.artifacts } : {}),
        ...(event.truncated ? { truncated: event.truncated } : {}),
      };
    case "plan_update":
      return { ...base, kind: "plan", summary: event.summary };
    case "approval_request":
      return {
        ...base,
        kind: "approval",
        status: "requested",
        callId: event.callId,
        toolName: event.toolName,
        reason: event.reason,
        permissionLevel: event.permissionLevel,
        isDestructive: event.isDestructive,
      };
    case "approval":
      return {
        ...base,
        kind: "approval",
        status: "denied",
        toolName: event.toolName,
        reason: event.reason,
      };
    case "context_compaction":
      return {
        ...base,
        kind: "compaction",
        phase: event.phase,
        reason: event.reason,
        inputMessages: event.inputMessages,
        outputMessages: event.outputMessages,
        summaryPreview: event.summaryPreview,
      };
    case "final":
      return {
        ...base,
        kind: "final",
        success: event.success,
        outputPreview: event.outputPreview,
      };
    case "stopped":
      return {
        ...base,
        kind: "stopped",
        reason: event.reason,
        ...(event.reasonDetail ? { reasonDetail: event.reasonDetail } : {}),
      };
  }
}
