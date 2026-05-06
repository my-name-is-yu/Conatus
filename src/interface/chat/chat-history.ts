// ─── ChatHistory ───
//
// Manages conversation history for a chat session.
// Persists via StateManager.writeRaw (persist-before-execute principle).

import { z } from "zod";
import type { StateManager } from "../../base/state/state-manager.js";
import { RuntimeReplyTargetSchema, type RuntimeReplyTarget } from "../../runtime/session-registry/types.js";
import { redactSetupSecrets, SetupSecretIntakeItemSchema } from "./setup-secret-intake.js";
import { SetupDialoguePublicStateSchema, type SetupDialoguePublicState } from "./setup-dialogue.js";
import { RunSpecSchema } from "../../runtime/run-spec/index.js";

// ─── Schemas ───

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  timestamp: z.string(), // ISO 8601
  turnIndex: z.number().int().min(0),
  setupSecretIntake: z.array(SetupSecretIntakeItemSchema.omit({ value: true })).optional(),
}).passthrough();
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatSessionAgentLoopMetadataSchema = z.object({
  statePath: z.string().nullable().optional(),
  status: z.enum(["running", "completed", "failed"]).nullable().optional(),
  resumable: z.boolean().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
}).passthrough();
export type ChatSessionAgentLoopMetadata = z.infer<typeof ChatSessionAgentLoopMetadataSchema>;

export const ChatUsageCounterSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
}).passthrough();
export type ChatUsageCounter = z.infer<typeof ChatUsageCounterSchema>;

export const ChatSessionUsageSchema = z.object({
  totals: ChatUsageCounterSchema.default({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }),
  byPhase: z.record(ChatUsageCounterSchema).default({}),
  updatedAt: z.string().optional(),
}).passthrough();
export type ChatSessionUsage = z.infer<typeof ChatSessionUsageSchema>;

export const ChatTurnContextSnapshotSchema = z.object({
  schema_version: z.string(),
  modelVisible: z.unknown(),
}).passthrough();
export type ChatTurnContextSnapshot = z.infer<typeof ChatTurnContextSnapshotSchema>;

export const RunSpecConfirmationStateSchema = z.object({
  state: z.enum(["pending", "confirmed", "cancelled"]),
  spec: RunSpecSchema,
  prompt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough();
export type RunSpecConfirmationState = z.infer<typeof RunSpecConfirmationStateSchema>;

export const ChatSessionSchema = z.object({
  id: z.string(),
  cwd: z.string(), // git root at session start
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  title: z.string().trim().min(1).max(200).nullable().optional(),
  parentSessionId: z.string().nullable().optional(),
  spawnedBySessionId: z.string().nullable().optional(),
  spawnedByRuntimeSessionId: z.string().nullable().optional(),
  spawnedAt: z.string().nullable().optional(),
  sessionStatus: z.enum(["idle", "queued", "running", "waiting", "completed", "failed"]).nullable().optional(),
  sessionSummary: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  goalId: z.string().nullable().optional(),
  strategyId: z.string().nullable().optional(),
  notificationPolicy: z.enum(["silent", "important_only", "periodic", "all_terminal"]).nullable().optional(),
  ownerId: z.string().nullable().optional(),
  ownerClaimedAt: z.string().nullable().optional(),
  waitingUntil: z.string().nullable().optional(),
  waitingCondition: z.string().nullable().optional(),
  retryCount: z.number().int().nonnegative().nullable().optional(),
  lastRetryAt: z.string().nullable().optional(),
  lastResumedAt: z.string().nullable().optional(),
  notificationReplyTarget: RuntimeReplyTargetSchema.nullable().optional(),
  parentNotificationStatus: z.enum(["none", "pending", "sent", "failed"]).nullable().optional(),
  parentNotificationSummary: z.string().nullable().optional(),
  parentNotifiedAt: z.string().nullable().optional(),
  setupDialogue: SetupDialoguePublicStateSchema.nullable().optional(),
  runSpecConfirmation: RunSpecConfirmationStateSchema.nullable().optional(),
  messages: z.array(ChatMessageSchema),
  compactionSummary: z.string().optional(),
  agentLoopStatePath: z.string().nullable().optional(),
  agentLoopStatus: z.enum(["running", "completed", "failed"]).nullable().optional(),
  agentLoopResumable: z.boolean().nullable().optional(),
  agentLoopUpdatedAt: z.string().nullable().optional(),
  agentLoop: ChatSessionAgentLoopMetadataSchema.optional(),
  turnContexts: z.array(ChatTurnContextSnapshotSchema).optional(),
  usage: ChatSessionUsageSchema.optional(),
}).passthrough();
export type ChatSession = z.infer<typeof ChatSessionSchema>;

// ─── ChatHistory ───

export class ChatHistory {
  private readonly stateManager: StateManager;
  private readonly sessionId: string;
  private readonly session: ChatSession;

  constructor(stateManager: StateManager, sessionId: string, cwd: string, existingSession?: ChatSession) {
    this.stateManager = stateManager;
    this.sessionId = sessionId;
    if (existingSession) {
      this.session = {
        ...existingSession,
        id: existingSession.id,
        cwd: existingSession.cwd,
        updatedAt: existingSession.updatedAt ?? existingSession.createdAt,
        messages: [...existingSession.messages],
        ...(existingSession.turnContexts ? { turnContexts: [...existingSession.turnContexts] } : {}),
        ...(existingSession.usage ? { usage: cloneUsage(existingSession.usage) } : {}),
      };
    } else {
      const createdAt = new Date().toISOString();
      this.session = {
        id: sessionId,
        cwd,
        createdAt,
        updatedAt: createdAt,
        messages: [],
      };
    }
  }

  static fromSession(stateManager: StateManager, session: ChatSession): ChatHistory {
    return new ChatHistory(stateManager, session.id, session.cwd, session);
  }

  /** Append a user message and persist to disk BEFORE adapter execution. */
  async appendUserMessage(content: string, options: { setupSecretIntake?: Array<Omit<z.infer<typeof SetupSecretIntakeItemSchema>, "value">> } = {}): Promise<void> {
    this.session.messages.push({
      role: "user",
      content,
      timestamp: new Date().toISOString(),
      turnIndex: this.session.messages.length,
      ...(options.setupSecretIntake && options.setupSecretIntake.length > 0
        ? { setupSecretIntake: options.setupSecretIntake }
        : {}),
    });
    await this.persist();
  }

  /** Append an assistant message and persist it as the committed assistant turn. */
  async appendAssistantMessage(content: string): Promise<void> {
    this.session.messages.push({
      role: "assistant",
      content: redactSetupSecrets(content),
      timestamp: new Date().toISOString(),
      turnIndex: this.session.messages.length,
    });
    await this.persist();
  }

  /** Clear all messages and persist the empty state. */
  async clear(): Promise<void> {
    this.session.messages = [];
    delete this.session.compactionSummary;
    await this.persist();
  }

  /** Persist a compacted summary and keep only the latest turns in message history. */
  async compact(summary: string, keepMessageCount = 4): Promise<{ before: number; after: number }> {
    const before = this.session.messages.length;
    const keepCount = Math.max(0, keepMessageCount);
    const kept = keepCount === 0 ? [] : this.session.messages.slice(-keepCount);
    this.session.messages = kept.map((message, index) => ({
      ...message,
      turnIndex: index,
    }));
    this.session.compactionSummary = summary;
    await this.persist();
    return { before, after: this.session.messages.length };
  }

  async removeLastTurn(): Promise<number> {
    if (this.session.messages.length === 0) return 0;

    let removed = 0;
    while (this.session.messages.length > 0) {
      const message = this.session.messages.pop();
      if (!message) break;
      removed += 1;
      if (message.role === "user") break;
    }

    this.session.messages = this.session.messages.map((message, index) => ({
      ...message,
      turnIndex: index,
    }));
    await this.persist();
    return removed;
  }

  getMessages(): ChatMessage[] {
    return [...this.session.messages];
  }

  getSessionData(): ChatSession {
    return {
      ...this.session,
      messages: [...this.session.messages],
      ...(this.session.turnContexts ? { turnContexts: [...this.session.turnContexts] } : {}),
      ...(this.session.usage ? { usage: cloneUsage(this.session.usage) } : {}),
    };
  }

  getSessionId(): string {
    return this.sessionId;
  }

  setTitle(title: string | null): void {
    if (title && title.trim().length > 0) {
      this.session.title = title.trim();
    } else {
      delete this.session.title;
    }
  }

  setAgentLoopStatePath(statePath: string | null): void {
    if (statePath) {
      this.session.agentLoopStatePath = statePath;
    } else {
      delete this.session.agentLoopStatePath;
    }
  }

  setNotificationReplyTarget(target: RuntimeReplyTarget | null): void {
    if (target) {
      this.session.notificationReplyTarget = target;
    } else {
      delete this.session.notificationReplyTarget;
    }
  }

  getSetupDialogue(): SetupDialoguePublicState | null {
    return this.session.setupDialogue ?? null;
  }

  setSetupDialogue(dialogue: SetupDialoguePublicState | null): void {
    if (dialogue) {
      this.session.setupDialogue = dialogue;
    } else {
      delete this.session.setupDialogue;
    }
  }

  getRunSpecConfirmation(): RunSpecConfirmationState | null {
    return this.session.runSpecConfirmation ?? null;
  }

  setRunSpecConfirmation(confirmation: RunSpecConfirmationState | null): void {
    if (confirmation) {
      this.session.runSpecConfirmation = confirmation;
    } else {
      delete this.session.runSpecConfirmation;
    }
  }

  async recordTurnContext(snapshot: { schema_version: string; modelVisible: unknown }): Promise<void> {
    this.session.turnContexts = [
      ...(this.session.turnContexts ?? []),
      snapshot,
    ].slice(-20);
    await this.persist();
  }

  setSessionLifecycle(input: {
    status?: "idle" | "queued" | "running" | "waiting" | "completed" | "failed" | null;
    summary?: string | null;
    completedAt?: string | null;
    goalId?: string | null;
    strategyId?: string | null;
    notificationPolicy?: "silent" | "important_only" | "periodic" | "all_terminal" | null;
    ownerId?: string | null;
    ownerClaimedAt?: string | null;
    waitingUntil?: string | null;
    waitingCondition?: string | null;
    retryCount?: number | null;
    lastRetryAt?: string | null;
    lastResumedAt?: string | null;
    parentNotificationStatus?: "none" | "pending" | "sent" | "failed" | null;
    parentNotificationSummary?: string | null;
    parentNotifiedAt?: string | null;
  }): void {
    if (input.status !== undefined) {
      if (input.status) this.session.sessionStatus = input.status;
      else delete this.session.sessionStatus;
    }
    if (input.summary !== undefined) {
      if (input.summary !== null) this.session.sessionSummary = input.summary;
      else delete this.session.sessionSummary;
    }
    if (input.completedAt !== undefined) {
      if (input.completedAt !== null) this.session.completedAt = input.completedAt;
      else delete this.session.completedAt;
    }
    if (input.goalId !== undefined) {
      if (input.goalId !== null) this.session.goalId = input.goalId;
      else delete this.session.goalId;
    }
    if (input.strategyId !== undefined) {
      if (input.strategyId !== null) this.session.strategyId = input.strategyId;
      else delete this.session.strategyId;
    }
    if (input.notificationPolicy !== undefined) {
      if (input.notificationPolicy !== null) this.session.notificationPolicy = input.notificationPolicy;
      else delete this.session.notificationPolicy;
    }
    if (input.ownerId !== undefined) {
      if (input.ownerId !== null) this.session.ownerId = input.ownerId;
      else delete this.session.ownerId;
    }
    if (input.ownerClaimedAt !== undefined) {
      if (input.ownerClaimedAt !== null) this.session.ownerClaimedAt = input.ownerClaimedAt;
      else delete this.session.ownerClaimedAt;
    }
    if (input.waitingUntil !== undefined) {
      if (input.waitingUntil !== null) this.session.waitingUntil = input.waitingUntil;
      else delete this.session.waitingUntil;
    }
    if (input.waitingCondition !== undefined) {
      if (input.waitingCondition !== null) this.session.waitingCondition = input.waitingCondition;
      else delete this.session.waitingCondition;
    }
    if (input.retryCount !== undefined) {
      if (input.retryCount !== null) this.session.retryCount = input.retryCount;
      else delete this.session.retryCount;
    }
    if (input.lastRetryAt !== undefined) {
      if (input.lastRetryAt !== null) this.session.lastRetryAt = input.lastRetryAt;
      else delete this.session.lastRetryAt;
    }
    if (input.lastResumedAt !== undefined) {
      if (input.lastResumedAt !== null) this.session.lastResumedAt = input.lastResumedAt;
      else delete this.session.lastResumedAt;
    }
    if (input.parentNotificationStatus !== undefined) {
      if (input.parentNotificationStatus) this.session.parentNotificationStatus = input.parentNotificationStatus;
      else delete this.session.parentNotificationStatus;
    }
    if (input.parentNotificationSummary !== undefined) {
      if (input.parentNotificationSummary !== null) this.session.parentNotificationSummary = input.parentNotificationSummary;
      else delete this.session.parentNotificationSummary;
    }
    if (input.parentNotifiedAt !== undefined) {
      if (input.parentNotifiedAt !== null) this.session.parentNotifiedAt = input.parentNotifiedAt;
      else delete this.session.parentNotifiedAt;
    }
  }

  resetAgentLoopState(statePath: string | null): void {
    this.setAgentLoopStatePath(statePath);
    delete this.session.agentLoopStatus;
    delete this.session.agentLoopResumable;
    delete this.session.agentLoopUpdatedAt;
    delete this.session.agentLoop;
  }

  recordUsage(phase: string, usage: ChatUsageCounter): void {
    const normalized = normalizeUsageCounter(usage);
    const nextTotals = sumUsage(
      this.session.usage?.totals,
      normalized
    );
    const currentPhase = this.session.usage?.byPhase?.[phase];
    const nextByPhase = {
      ...(this.session.usage?.byPhase ?? {}),
      [phase]: sumUsage(currentPhase, normalized),
    };
    this.session.usage = {
      totals: nextTotals,
      byPhase: nextByPhase,
      updatedAt: new Date().toISOString(),
    };
  }

  async persist(): Promise<void> {
    this.session.updatedAt = new Date().toISOString();
    await this.stateManager.writeRaw(
      `chat/sessions/${this.sessionId}.json`,
      this.session
    );
  }
}

function normalizeUsageCounter(usage: ChatUsageCounter): ChatUsageCounter {
  const inputTokens = Number.isFinite(usage.inputTokens) ? Math.max(0, Math.floor(usage.inputTokens)) : 0;
  const outputTokens = Number.isFinite(usage.outputTokens) ? Math.max(0, Math.floor(usage.outputTokens)) : 0;
  const totalTokens = Number.isFinite(usage.totalTokens)
    ? Math.max(0, Math.floor(usage.totalTokens))
    : inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function sumUsage(base: ChatUsageCounter | undefined, delta: ChatUsageCounter): ChatUsageCounter {
  const normalizedBase = normalizeUsageCounter(base ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  return {
    inputTokens: normalizedBase.inputTokens + delta.inputTokens,
    outputTokens: normalizedBase.outputTokens + delta.outputTokens,
    totalTokens: normalizedBase.totalTokens + delta.totalTokens,
  };
}

function cloneUsage(usage: ChatSessionUsage): ChatSessionUsage {
  return {
    totals: { ...usage.totals },
    byPhase: Object.fromEntries(
      Object.entries(usage.byPhase ?? {}).map(([phase, counter]) => [phase, { ...counter }])
    ),
    ...(usage.updatedAt ? { updatedAt: usage.updatedAt } : {}),
  };
}
