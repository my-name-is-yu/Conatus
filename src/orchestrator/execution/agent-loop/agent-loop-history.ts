import type { AgentLoopMessage } from "./agent-loop-model.js";
import type { AgentLoopCompactionRecord } from "./agent-loop-compaction-record.js";
import { cloneAgentLoopCompactionRecords } from "./agent-loop-compaction-record.js";

export interface AgentLoopHistory {
  messages: AgentLoopMessage[];
  compacted: boolean;
  compactionRecords: AgentLoopCompactionRecord[];
}

export function createAgentLoopHistory(
  messages: AgentLoopMessage[] = [],
  compactionRecords: readonly AgentLoopCompactionRecord[] = [],
): AgentLoopHistory {
  return {
    messages: [...messages],
    compacted: compactionRecords.length > 0,
    compactionRecords: cloneAgentLoopCompactionRecords(compactionRecords),
  };
}

export function appendAgentLoopHistory(history: AgentLoopHistory, messages: AgentLoopMessage[]): AgentLoopHistory {
  return {
    ...history,
    messages: [...history.messages, ...messages],
    compactionRecords: cloneAgentLoopCompactionRecords(history.compactionRecords),
  };
}
