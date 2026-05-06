import type {
  AgentLoopMessage,
  AgentLoopMessagePhase,
  AgentLoopMessageRole,
  AgentLoopToolCall,
  AgentLoopToolObservation,
  AgentLoopToolObservationExecution,
} from "./agent-loop-model.js";

export const AGENT_LOOP_COMPACTION_RECORD_SCHEMA_VERSION = "agent-loop-compaction-record-v1";

export type AgentLoopCompactionPhase = "pre_turn" | "mid_turn" | "standalone_turn";
export type AgentLoopCompactionReason = "context_limit" | "model_downshift" | "manual";
export type AgentLoopCompactionTargetState = "archived" | "retained";

export interface AgentLoopCompactionMessageRef {
  index: number;
  role: AgentLoopMessageRole;
  content: string;
  phase?: AgentLoopMessagePhase;
  toolCallId?: string;
  toolName?: string;
}

export interface AgentLoopCompactionToolObservationRef {
  index: number;
  callId: string;
  toolName: string;
  state: AgentLoopToolObservation["state"];
  success: boolean;
  execution?: AgentLoopToolObservationExecution;
  arguments: unknown;
  output: AgentLoopToolObservation["output"];
  command?: string;
  cwd?: string;
  artifacts?: string[];
  activityCategory?: AgentLoopToolObservation["activityCategory"];
}

export interface AgentLoopCompactionPendingPermission {
  index: number;
  callId: string;
  toolName: string;
  state: AgentLoopToolObservation["state"];
  execution?: AgentLoopToolObservationExecution;
  output: AgentLoopToolObservation["output"];
}

export interface AgentLoopCompactionToolTarget {
  state: AgentLoopCompactionTargetState;
  source: "assistant_tool_call" | "tool_observation";
  index: number;
  callId: string;
  toolName: string;
  input?: unknown;
  arguments?: unknown;
  outputData?: unknown;
}

export interface AgentLoopCompactionReplacementHistory {
  summarizedIndexes: number[];
  retainedIndexes: number[];
  systemIndexes: number[];
  summaryMessageInserted: boolean;
}

export interface AgentLoopCompactionRecord {
  schemaVersion: typeof AGENT_LOOP_COMPACTION_RECORD_SCHEMA_VERSION;
  sequence: number;
  createdAt: string;
  phase: AgentLoopCompactionPhase;
  reason: AgentLoopCompactionReason;
  inputMessageCount: number;
  outputMessageCount: number;
  summarizedMessageCount: number;
  retainedTailCount: number;
  summary: string;
  modelVisibleSummary: string;
  userMessages: AgentLoopCompactionMessageRef[];
  assistantDecisions: Array<AgentLoopCompactionMessageRef & { toolCalls?: AgentLoopToolCall[] }>;
  toolObservations: AgentLoopCompactionToolObservationRef[];
  pendingPermissions: AgentLoopCompactionPendingPermission[];
  activeTargets: AgentLoopCompactionToolTarget[];
  archivedTargets: AgentLoopCompactionToolTarget[];
  replacementHistory: AgentLoopCompactionReplacementHistory;
}

export function cloneAgentLoopCompactionRecords(
  records: readonly AgentLoopCompactionRecord[] | undefined,
): AgentLoopCompactionRecord[] {
  return records ? records.map((record) => cloneJson(record)) : [];
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
