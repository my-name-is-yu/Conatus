import type { FailureRecoveryGuidance } from "./failure-recovery.js";
import type { AgentTimelineItem } from "../../orchestrator/execution/agent-loop/agent-timeline.js";

export interface ChatEventBase {
  runId: string;
  turnId: string;
  createdAt: string;
}

export interface LifecycleStartEvent extends ChatEventBase {
  type: "lifecycle_start";
  input: string;
}

export interface AssistantDeltaEvent extends ChatEventBase {
  type: "assistant_delta";
  delta: string;
  text: string;
}

export interface AssistantFinalEvent extends ChatEventBase {
  type: "assistant_final";
  text: string;
  persisted: boolean;
}

export type ActivityKind = "lifecycle" | "commentary" | "checkpoint" | "diff" | "tool" | "plugin" | "skill";

export interface ActivityEvent extends ChatEventBase {
  type: "activity";
  kind: ActivityKind;
  message: string;
  sourceId?: string;
  transient?: boolean;
}

export interface ToolStartEvent extends ChatEventBase {
  type: "tool_start";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolUpdateEvent extends ChatEventBase {
  type: "tool_update";
  toolCallId: string;
  toolName: string;
  status: "awaiting_approval" | "running" | "result";
  message: string;
}

export interface ToolEndEvent extends ChatEventBase {
  type: "tool_end";
  toolCallId: string;
  toolName: string;
  success: boolean;
  summary: string;
  durationMs: number;
}

export interface AgentTimelineEvent extends ChatEventBase {
  type: "agent_timeline";
  item: AgentTimelineItem;
}

export interface LifecycleEndEvent extends ChatEventBase {
  type: "lifecycle_end";
  status: "completed" | "error";
  elapsedMs: number;
  persisted: boolean;
}

export interface LifecycleErrorEvent extends ChatEventBase {
  type: "lifecycle_error";
  error: string;
  partialText: string;
  persisted: false;
  recovery: FailureRecoveryGuidance;
}

export type ChatEvent =
  | LifecycleStartEvent
  | AssistantDeltaEvent
  | AssistantFinalEvent
  | ActivityEvent
  | AgentTimelineEvent
  | ToolStartEvent
  | ToolUpdateEvent
  | ToolEndEvent
  | LifecycleEndEvent
  | LifecycleErrorEvent;

export type ChatEventHandler = (event: ChatEvent) => Promise<void> | void;

export interface ChatEventContext {
  runId: string;
  turnId: string;
}
