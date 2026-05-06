import type { AgentLoopReasoningEffort, AgentLoopToolObservationExecution } from "./agent-loop-model.js";
import type { ExecutionPolicy } from "./execution-policy.js";
import type { AgentLoopStopReason } from "./agent-loop-budget.js";

export type AgentLoopCommandResultCategory = "verification" | "observation" | "other";

export interface AgentLoopCommandResult {
  sequence?: number;
  toolName: string;
  command: string;
  cwd: string;
  success: boolean;
  execution?: AgentLoopToolObservationExecution;
  category: AgentLoopCommandResultCategory;
  evidenceEligible: boolean;
  relevantToTask?: boolean;
  outputSummary: string;
  durationMs: number;
}

export interface AgentLoopToolResultSummary {
  sequence?: number;
  toolName: string;
  success: boolean;
  execution?: AgentLoopToolObservationExecution;
  artifacts?: string[];
  checkOnly?: boolean;
  outputSummary: string;
  durationMs: number;
}

export type AgentLoopWorkspaceDisposition =
  | "not_isolated"
  | "cleaned_up"
  | "kept_clean"
  | "handoff_required"
  | "discarded";

export interface AgentLoopWorkspaceInfo {
  requestedCwd: string;
  executionCwd: string;
  isolated: boolean;
  cleanupStatus?: "not_requested" | "cleaned_up" | "kept";
  cleanupReason?: string;
  dirty?: boolean;
  disposition?: AgentLoopWorkspaceDisposition;
}

export interface AgentLoopTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AgentLoopResult<TOutput> {
  success: boolean;
  output: TOutput | null;
  finalText: string;
  stopReason: AgentLoopStopReason;
  elapsedMs: number;
  modelTurns: number;
  toolCalls: number;
  usage?: AgentLoopTokenUsage;
  compactions: number;
  filesChanged?: boolean;
  changedFiles: string[];
  toolResults?: AgentLoopToolResultSummary[];
  commandResults: AgentLoopCommandResult[];
  workspace?: AgentLoopWorkspaceInfo;
  traceId: string;
  sessionId: string;
  turnId: string;
  profileName?: string;
  reasoningEffort?: AgentLoopReasoningEffort;
  executionPolicy?: ExecutionPolicy;
}

export interface AgentLoopCompletionValidationResult {
  ok: boolean;
  reasons: string[];
}
