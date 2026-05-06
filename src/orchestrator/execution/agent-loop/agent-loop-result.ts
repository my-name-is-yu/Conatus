import type { AgentLoopReasoningEffort, AgentLoopToolObservationExecution } from "./agent-loop-model.js";
import type { ExecutionPolicy } from "./execution-policy.js";
import type { AgentLoopStopReason } from "./agent-loop-budget.js";

export type AgentLoopCommandResultCategory = "verification" | "observation" | "other";

export interface AgentLoopCommandResult {
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
  toolName: string;
  success: boolean;
  execution?: AgentLoopToolObservationExecution;
  outputSummary: string;
  durationMs: number;
}

export interface AgentLoopWorkspaceInfo {
  requestedCwd: string;
  executionCwd: string;
  isolated: boolean;
  cleanupStatus?: "not_requested" | "cleaned_up" | "kept";
  cleanupReason?: string;
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
