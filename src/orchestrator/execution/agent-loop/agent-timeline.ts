import type { AgentLoopEvent } from "./agent-loop-events.js";
import type { ToolActivityCategory } from "../../../tools/types.js";

export type AgentTimelineItem =
  | AgentTimelineLifecycleItem
  | AgentTimelineTurnContextItem
  | AgentTimelineModelRequestItem
  | AgentTimelineAssistantMessageItem
  | AgentTimelineToolItem
  | AgentTimelinePlanItem
  | AgentTimelineApprovalItem
  | AgentTimelineCompactionItem
  | AgentTimelineActivitySummaryItem
  | AgentTimelineFinalItem
  | AgentTimelineStoppedItem;

export type AgentTimelineActivityKind = ToolActivityCategory;

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
  activityCategory?: AgentTimelineActivityKind;
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

export interface AgentTimelineActivitySummaryItem extends AgentTimelineBaseItem {
  kind: "activity_summary";
  buckets: AgentTimelineActivitySummaryBucket[];
  text: string;
}

export interface AgentTimelineActivitySummaryBucket {
  kind: AgentTimelineActivityKind;
  count: number;
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
        ...(event.activityCategory ? { activityCategory: event.activityCategory } : {}),
        inputPreview: event.inputPreview,
      };
    case "tool_call_finished":
      return {
        ...base,
        kind: "tool",
        status: "finished",
        callId: event.callId,
        toolName: event.toolName,
        ...(event.activityCategory ? { activityCategory: event.activityCategory } : {}),
        success: event.success,
        ...(event.inputPreview ? { inputPreview: event.inputPreview } : {}),
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

export function summarizeAgentTimelineActivity(items: AgentTimelineItem[]): AgentTimelineActivitySummaryBucket[] {
  const counts = new Map<AgentTimelineActivityKind, number>();
  for (const item of items) {
    const kind = classifyTimelineActivity(item);
    if (!kind) continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return ACTIVITY_SUMMARY_ORDER
    .map((kind) => ({ kind, count: counts.get(kind) ?? 0 }))
    .filter((bucket) => bucket.count > 0);
}

export function createAgentTimelineActivitySummary(input: {
  id: string;
  sourceEventId: string;
  sessionId: string;
  traceId: string;
  turnId: string;
  goalId: string;
  taskId?: string;
  createdAt: string;
  items: AgentTimelineItem[];
}): AgentTimelineActivitySummaryItem | null {
  const buckets = summarizeAgentTimelineActivity(input.items);
  if (buckets.length === 0) return null;
  return {
    id: input.id,
    sourceEventId: input.sourceEventId,
    sourceType: "tool_call_finished",
    sessionId: input.sessionId,
    traceId: input.traceId,
    turnId: input.turnId,
    goalId: input.goalId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    createdAt: input.createdAt,
    visibility: "user",
    kind: "activity_summary",
    buckets,
    text: formatAgentTimelineActivitySummary(buckets),
  };
}

export function formatAgentTimelineActivitySummary(buckets: AgentTimelineActivitySummaryBucket[]): string {
  return buckets.map((bucket) => {
    const label = ACTIVITY_SUMMARY_LABELS[bucket.kind];
    return `${label} ${bucket.count} ${bucket.count === 1 ? ACTIVITY_SUMMARY_NOUNS[bucket.kind].singular : ACTIVITY_SUMMARY_NOUNS[bucket.kind].plural}`;
  }).join(", ");
}

function classifyTimelineActivity(item: AgentTimelineItem): AgentTimelineActivityKind | null {
  if (item.kind === "approval" && item.status === "requested") return "approval";
  if (item.kind !== "tool" || item.status !== "finished") return null;
  return classifyToolActivity(item.activityCategory, item.inputPreview);
}

function classifyToolActivity(
  activityCategory: AgentTimelineActivityKind | undefined,
  inputPreview?: string,
): AgentTimelineActivityKind {
  const input = parseToolInputPreview(inputPreview);
  const command = stringField(input, "command") ?? stringField(input, "cmd");
  if (command && (!activityCategory || activityCategory === "command")) {
    return classifyCommandActivity(command);
  }
  if (activityCategory) return activityCategory;
  return "command";
}

function classifyCommandActivity(command: string): AgentTimelineActivityKind {
  const trimmed = command.trim();
  const executable = firstCommandToken(trimmed);
  if (["rg", "grep", "ag", "ack"].includes(executable)) return "search";
  if (["cat", "sed", "awk", "ls", "find", "pwd", "head", "tail"].includes(executable)) return "read";
  if (executable === "git") {
    const subcommand = firstCommandToken(trimmed.split(/\s+/).slice(1).join(" "));
    if (["grep"].includes(subcommand)) return "search";
    if (["show", "log", "status", "diff", "ls-files"].includes(subcommand)) return "read";
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    if (/\b(test|vitest|jest|typecheck|lint|check|verify)\b/.test(trimmed)) return "test";
  }
  if (["pytest", "vitest", "jest"].includes(executable)) return "test";
  if (executable === "go" && /\btest\b/.test(trimmed)) return "test";
  if (executable === "cargo" && /\btest\b/.test(trimmed)) return "test";
  return "command";
}

function parseToolInputPreview(inputPreview?: string): Record<string, unknown> | null {
  if (!inputPreview) return null;
  try {
    const parsed = JSON.parse(inputPreview);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringField(input: Record<string, unknown> | null, field: string): string | null {
  const value = input?.[field];
  return typeof value === "string" ? value : null;
}

function firstCommandToken(command: string): string {
  return command.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

const ACTIVITY_SUMMARY_ORDER: AgentTimelineActivityKind[] = [
  "search",
  "read",
  "command",
  "file_create",
  "file_modify",
  "test",
  "approval",
];

const ACTIVITY_SUMMARY_LABELS: Record<AgentTimelineActivityKind, string> = {
  search: "searched",
  read: "read",
  command: "ran",
  file_create: "created",
  file_modify: "modified",
  test: "verified",
  approval: "requested",
};

const ACTIVITY_SUMMARY_NOUNS: Record<AgentTimelineActivityKind, { singular: string; plural: string }> = {
  search: { singular: "search", plural: "searches" },
  read: { singular: "file", plural: "files" },
  command: { singular: "command", plural: "commands" },
  file_create: { singular: "file", plural: "files" },
  file_modify: { singular: "file", plural: "files" },
  test: { singular: "check", plural: "checks" },
  approval: { singular: "approval", plural: "approvals" },
};
