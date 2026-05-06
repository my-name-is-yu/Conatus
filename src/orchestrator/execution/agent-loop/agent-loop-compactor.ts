import type { AgentLoopMessage, AgentLoopToolObservation } from "./agent-loop-model.js";
import type { AgentLoopHistory } from "./agent-loop-history.js";
import type {
  AgentLoopCompactionPhase,
  AgentLoopCompactionReason,
  AgentLoopCompactionRecord,
  AgentLoopCompactionToolObservationRef,
  AgentLoopCompactionToolTarget,
  AgentLoopCompactionMessageRef,
  AgentLoopCompactionPendingPermission,
} from "./agent-loop-compaction-record.js";
import { AGENT_LOOP_COMPACTION_RECORD_SCHEMA_VERSION } from "./agent-loop-compaction-record.js";

export type { AgentLoopCompactionPhase, AgentLoopCompactionReason } from "./agent-loop-compaction-record.js";

export interface AgentLoopCompactionInput {
  history: AgentLoopHistory;
  maxMessages?: number;
  phase?: AgentLoopCompactionPhase;
  reason?: AgentLoopCompactionReason;
}

export interface AgentLoopCompactionResult {
  history: AgentLoopHistory;
  compacted: boolean;
  summary?: string;
}

export interface AgentLoopCompactor {
  compact(input: AgentLoopCompactionInput): Promise<AgentLoopCompactionResult>;
}

export class NoopAgentLoopCompactor implements AgentLoopCompactor {
  async compact(input: AgentLoopCompactionInput): Promise<AgentLoopCompactionResult> {
    return {
      history: {
        ...input.history,
        messages: [...input.history.messages],
        compactionRecords: [...input.history.compactionRecords],
      },
      compacted: false,
    };
  }
}

export const AGENT_LOOP_COMPACTION_SUMMARY_PREFIX = "Summary of earlier agentloop context:";

export interface ExtractiveAgentLoopCompactorOptions {
  defaultMaxMessages?: number;
  maxSummaryChars?: number;
}

export class ExtractiveAgentLoopCompactor implements AgentLoopCompactor {
  private readonly defaultMaxMessages: number;
  private readonly maxSummaryChars: number;

  constructor(options: ExtractiveAgentLoopCompactorOptions = {}) {
    this.defaultMaxMessages = options.defaultMaxMessages ?? 8;
    this.maxSummaryChars = options.maxSummaryChars ?? 6000;
  }

  async compact(input: AgentLoopCompactionInput): Promise<AgentLoopCompactionResult> {
    const maxMessages = Math.max(3, input.maxMessages ?? this.defaultMaxMessages);
    const messages = input.history.messages;
    if (messages.length <= maxMessages) {
      return { history: input.history, compacted: false };
    }

    const indexedMessages = messages.map((message, index) => ({ message, index }));
    const systemEntries = indexedMessages.filter(({ message }) => message.role === "system");
    const nonSystemEntries = indexedMessages.filter(({ message }) => message.role !== "system");
    const systemMessages = systemEntries.map(({ message }) => message);
    const tailCount = Math.max(2, maxMessages - systemMessages.length - 1);
    const rawTailEntries = nonSystemEntries.slice(-tailCount);
    const tailEntries = rawTailEntries.filter(({ message }) => !isCompactionSummaryMessage(message));
    const tailIndexSet = new Set(rawTailEntries.map(({ index }) => index));
    const summarizedEntries = nonSystemEntries
      .filter(({ index }) => !tailIndexSet.has(index))
      .filter(({ message }) => !isCompactionSummaryMessage(message));
    const tail = tailEntries.map(({ message }) => message);
    const summarized = summarizedEntries.map(({ message }) => message);

    if (summarized.length === 0) {
      return {
        history: {
          messages: [...systemMessages, ...tail],
          compacted: input.history.compacted,
          compactionRecords: [...input.history.compactionRecords],
        },
        compacted: false,
      };
    }

    const recordDraft = this.buildRecordDraft(summarizedEntries, tailEntries, systemEntries, input);
    const summary = this.buildSummary(recordDraft, input);
    const modelVisibleSummary = `${AGENT_LOOP_COMPACTION_SUMMARY_PREFIX}\n${summary}`;
    const replacement: AgentLoopMessage[] = [
      ...systemMessages,
      { role: "user", content: modelVisibleSummary },
      ...tail,
    ];
    const record: AgentLoopCompactionRecord = {
      schemaVersion: AGENT_LOOP_COMPACTION_RECORD_SCHEMA_VERSION,
      sequence: input.history.compactionRecords.length,
      createdAt: new Date().toISOString(),
      phase: input.phase ?? "standalone_turn",
      reason: input.reason ?? "context_limit",
      inputMessageCount: messages.length,
      outputMessageCount: replacement.length,
      summarizedMessageCount: summarizedEntries.length,
      retainedTailCount: tailEntries.length,
      summary,
      modelVisibleSummary,
      ...recordDraft,
    };
    return {
      history: {
        messages: replacement,
        compacted: true,
        compactionRecords: [...input.history.compactionRecords, record],
      },
      compacted: true,
      summary,
    };
  }

  private buildRecordDraft(
    summarizedEntries: Array<{ message: AgentLoopMessage; index: number }>,
    tailEntries: Array<{ message: AgentLoopMessage; index: number }>,
    systemEntries: Array<{ message: AgentLoopMessage; index: number }>,
    input: AgentLoopCompactionInput,
  ): Omit<
    AgentLoopCompactionRecord,
    | "schemaVersion"
    | "sequence"
    | "createdAt"
    | "phase"
    | "reason"
    | "inputMessageCount"
    | "outputMessageCount"
    | "summarizedMessageCount"
    | "retainedTailCount"
    | "summary"
    | "modelVisibleSummary"
  > {
    const targetEntries = [
      ...summarizedEntries.map((entry) => ({ ...entry, state: "archived" as const })),
      ...tailEntries.map((entry) => ({ ...entry, state: "retained" as const })),
    ];
    return {
      userMessages: summarizedEntries
        .filter(({ message }) => message.role === "user")
        .map(({ message, index }) => messageRef(message, index)),
      assistantDecisions: summarizedEntries
        .filter(({ message }) => message.role === "assistant")
        .map(({ message, index }) => ({
          ...messageRef(message, index),
          ...(message.toolCalls && message.toolCalls.length > 0 ? { toolCalls: cloneJson(message.toolCalls) } : {}),
        })),
      toolObservations: summarizedEntries.flatMap(({ message, index }) =>
        message.observation ? [toolObservationRef(message.observation, index)] : []
      ),
      pendingPermissions: summarizedEntries.flatMap(({ message, index }) =>
        message.observation && isPermissionConstraint(message.observation)
          ? [pendingPermissionRef(message.observation, index)]
          : []
      ),
      activeTargets: targetEntries.flatMap(({ message, index, state }) =>
        state === "retained" ? toolTargets(message, index, state) : []
      ),
      archivedTargets: targetEntries.flatMap(({ message, index, state }) =>
        state === "archived" ? toolTargets(message, index, state) : []
      ),
      replacementHistory: {
        summarizedIndexes: summarizedEntries.map(({ index }) => index),
        retainedIndexes: tailEntries.map(({ index }) => index),
        systemIndexes: systemEntries.map(({ index }) => index),
        summaryMessageInserted: summarizedEntries.length > 0,
      },
    };
  }

  private buildSummary(
    record: Omit<
      AgentLoopCompactionRecord,
      | "schemaVersion"
      | "sequence"
      | "createdAt"
      | "phase"
      | "reason"
      | "inputMessageCount"
      | "outputMessageCount"
      | "summarizedMessageCount"
      | "retainedTailCount"
      | "summary"
      | "modelVisibleSummary"
    >,
    input: AgentLoopCompactionInput,
  ): string {
    const header = [
      `phase: ${input.phase ?? "standalone_turn"}`,
      `reason: ${input.reason ?? "context_limit"}`,
      "Preserve task intent, tool results, files, failures, permissions, retained current targets, and archived stale targets.",
    ].join("\n");
    const userMessages = record.userMessages.map((message) =>
      `- message_index=${message.index}: ${preview(message.content, 700)}`
    );
    const assistantDecisions = record.assistantDecisions.map((message) => {
      const tools = message.toolCalls?.map((call) => call.name).join(", ");
      return `- message_index=${message.index}${tools ? ` tool_calls=${tools}` : ""}: ${preview(message.content, 700)}`;
    });
    const toolObservations = record.toolObservations.map((observation) =>
      `- message_index=${observation.index} tool=${observation.toolName} state=${observation.state} executed=${observation.execution?.status ?? "unknown"}: ${preview(observation.output.summary ?? observation.output.content, 700)}`
    );
    const pendingPermissions = record.pendingPermissions.map((permission) =>
      `- message_index=${permission.index} tool=${permission.toolName} state=${permission.state} reason=${permission.execution?.reason ?? "unknown"}: ${preview(permission.output.summary ?? permission.output.content, 500)}`
    );
    const activeTargets = record.activeTargets.map((target) =>
      `- retained message_index=${target.index} tool=${target.toolName} call_id=${target.callId}: ${preview(stringify(target.input ?? target.arguments ?? target.outputData ?? {}), 500)}`
    );
    const archivedTargets = record.archivedTargets.map((target) =>
      `- archived message_index=${target.index} tool=${target.toolName} call_id=${target.callId}; do not treat as current unless a later retained message re-selects it.`
    );
    const replacement = [
      `- summarized_indexes: ${record.replacementHistory.summarizedIndexes.join(", ") || "none"}`,
      `- retained_indexes: ${record.replacementHistory.retainedIndexes.join(", ") || "none"}`,
    ];
    const sections = [
      section("User messages", userMessages),
      section("Assistant decisions", assistantDecisions),
      section("Tool observations", toolObservations),
      section("Pending permissions", pendingPermissions),
      section("Retained active targets", activeTargets),
      section("Archived stale targets", archivedTargets),
      section("Replacement history", replacement),
    ].filter(Boolean);
    return preview(`${header}\n${sections.join("\n")}`, this.maxSummaryChars);
  }
}

function messageRef(message: AgentLoopMessage, index: number): AgentLoopCompactionMessageRef {
  return {
    index,
    role: message.role,
    content: message.content,
    ...(message.phase ? { phase: message.phase } : {}),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName ? { toolName: message.toolName } : {}),
  };
}

function toolObservationRef(
  observation: AgentLoopToolObservation,
  index: number,
): AgentLoopCompactionToolObservationRef {
  return {
    index,
    callId: observation.callId,
    toolName: observation.toolName,
    state: observation.state,
    success: observation.success,
    ...(observation.execution ? { execution: { ...observation.execution } } : {}),
    arguments: cloneJson(observation.arguments),
    output: cloneJson(observation.output),
    ...(observation.command ? { command: observation.command } : {}),
    ...(observation.cwd ? { cwd: observation.cwd } : {}),
    ...(observation.artifacts ? { artifacts: [...observation.artifacts] } : {}),
    ...(observation.activityCategory ? { activityCategory: observation.activityCategory } : {}),
  };
}

function pendingPermissionRef(
  observation: NonNullable<AgentLoopMessage["observation"]>,
  index: number,
): AgentLoopCompactionPendingPermission {
  return {
    index,
    callId: observation.callId,
    toolName: observation.toolName,
    state: observation.state,
    ...(observation.execution ? { execution: { ...observation.execution } } : {}),
    output: cloneJson(observation.output),
  };
}

function isPermissionConstraint(observation: NonNullable<AgentLoopMessage["observation"]>): boolean {
  if (observation.execution?.status !== "not_executed") return false;
  return observation.state === "denied" || observation.state === "blocked";
}

function toolTargets(
  message: AgentLoopMessage,
  index: number,
  state: AgentLoopCompactionToolTarget["state"],
): AgentLoopCompactionToolTarget[] {
  const assistantTargets = (message.toolCalls ?? []).map((call): AgentLoopCompactionToolTarget => ({
    state,
    source: "assistant_tool_call",
    index,
    callId: call.id,
    toolName: call.name,
    input: cloneJson(call.input),
  }));
  const observation = message.observation;
  const observationTargets = observation ? [{
    state,
    source: "tool_observation" as const,
    index,
    callId: observation.callId,
    toolName: observation.toolName,
    arguments: cloneJson(observation.arguments),
    ...(Object.prototype.hasOwnProperty.call(observation.output, "data")
      ? { outputData: cloneJson(observation.output.data) }
      : {}),
  }] : [];
  return [...assistantTargets, ...observationTargets];
}

function section(title: string, lines: string[]): string {
  return lines.length > 0 ? `${title}:\n${lines.join("\n")}` : "";
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isCompactionSummaryMessage(message: AgentLoopMessage): boolean {
  return message.role === "user" && message.content.startsWith(AGENT_LOOP_COMPACTION_SUMMARY_PREFIX);
}

function preview(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}
