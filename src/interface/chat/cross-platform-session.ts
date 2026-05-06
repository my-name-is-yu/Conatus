import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { ChatRunner } from "./chat-runner.js";
import type { ChatRunResult, ChatRunnerDeps } from "./chat-runner-contracts.js";
import type { ChatEvent, ChatEventHandler } from "./chat-events.js";
import {
  createIngressRouter,
  type ChatIngressChannel,
  type ChatIngressMessage,
  type ChatIngressReplyTarget,
  type ChatIngressRuntimeControl,
  type SelectedChatRoute,
} from "./ingress-router.js";
import { classifyRuntimeControlIntent } from "../../runtime/control/index.js";
import { classifyFreeformRouteIntent } from "./freeform-route-classifier.js";
import { deriveRunSpecFromText } from "../../runtime/run-spec/index.js";
import { intakeSetupSecrets } from "./setup-secret-intake.js";
import { StateManager } from "../../base/state/state-manager.js";
import { buildAdapterRegistry, buildLLMClient } from "../../base/llm/provider-factory.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import { TrustManager } from "../../platform/traits/trust-manager.js";
import { ObservationEngine } from "../../platform/observation/observation-engine.js";
import { resolveGitRoot } from "../../platform/observation/context-provider.js";
import { KnowledgeManager } from "../../platform/knowledge/knowledge-manager.js";
import { GoalDependencyGraph } from "../../orchestrator/goal/goal-dependency-graph.js";
import { SessionManager } from "../../orchestrator/execution/session-manager.js";
import { ScheduleEngine } from "../../runtime/schedule/engine.js";
import { PluginLoader } from "../../runtime/plugin-loader.js";
import { NotifierRegistry } from "../../runtime/notifier-registry.js";
import { buildCliDataSourceRegistry } from "../cli/data-source-bootstrap.js";
import {
  ConcurrencyController,
  createBuiltinTools,
  ToolExecutor,
  ToolPermissionManager,
  ToolRegistry,
} from "../../tools/index.js";
import {
  createNativeChatAgentLoopRunner,
  createNativeReviewAgentLoopRunner,
  shouldUseNativeTaskAgentLoop,
} from "../../orchestrator/execution/agent-loop/index.js";
import {
  RuntimeControlService,
  createDaemonRuntimeControlExecutor,
} from "../../runtime/control/index.js";
import { ApprovalBroker } from "../../runtime/approval-broker.js";
import { ApprovalStore, createRuntimeStorePaths } from "../../runtime/store/index.js";
import { classifyConversationalApprovalDecision } from "../../runtime/conversational-approval-decision.js";
import { registerGlobalCrossPlatformChatSessionManager } from "./cross-platform-session-global.js";
import type { RuntimeControlActor } from "../../runtime/store/runtime-operation-schemas.js";
import type { ApprovalOrigin } from "../../runtime/store/runtime-schemas.js";
import {
  buildCompanionRuntimeContract,
  evaluateCompanionOutputPolicy,
} from "../../runtime/companion-policy.js";
import type {
  CompanionPresenceState,
  CompanionRuntimeContract,
  CompanionTurnPolicy,
  ConversationInputModality,
  ConversationOutputMode,
} from "../../runtime/types/companion.js";
import { normalizeUserInput, type UserInput } from "./user-input.js";

export interface CrossPlatformChatSessionOptions {
  /**
   * Stable cross-platform join key.
   * When present, sessions with the same identity_key share one ChatRunner session.
   */
  identity_key?: string;
  /** Platform or transport name, e.g. "slack", "discord", "web". */
  platform?: string;
  /** Conversation/thread identifier on the transport. */
  conversation_id?: string;
  /** Human-readable conversation title or thread name. */
  conversation_name?: string;
  /** User identifier on the transport. */
  user_id?: string;
  /** Human-readable user name. */
  user_name?: string;
  /** Channel family for ingress normalization. */
  channel?: ChatIngressChannel;
  /** Optional per-turn message id from the transport. */
  message_id?: string;
  /** Optional goal selected by gateway routing for this turn. */
  goal_id?: string;
  /** Explicit typed actor override for routing/runtime control. */
  actor?: Partial<RuntimeControlActor>;
  /** Explicit reply target override for outbound routing. */
  replyTarget?: Partial<ChatIngressReplyTarget>;
  /** Explicit runtime-control policy for the turn. */
  runtimeControl?: Partial<ChatIngressRuntimeControl>;
  /** Shared companion presence/policy contract overrides for this turn. */
  companion?: {
    presence?: Partial<CompanionPresenceState>;
    turnPolicy?: Partial<CompanionTurnPolicy>;
    inputModality?: ConversationInputModality;
    outputMode?: ConversationOutputMode;
  };
  /** Workspace root or working directory used when the session is created. */
  cwd?: string;
  /** Per-turn timeout forwarded to ChatRunner. */
  timeoutMs?: number;
  /** Extra transport metadata for plugins to retain alongside the session. */
  metadata?: Record<string, unknown>;
  /** Optional streaming callback for ChatEvent updates. */
  onEvent?: ChatEventHandler;
  /** Canonical typed user input. If omitted, text is preserved as one text item. */
  userInput?: UserInput;
}

export interface CrossPlatformIncomingChatMessage {
  text: string;
  userInput?: UserInput;
  channel?: ChatIngressChannel;
  identity_key?: string;
  platform?: string;
  conversation_id?: string;
  conversation_name?: string;
  sender_id?: string;
  user_id?: string;
  user_name?: string;
  message_id?: string;
  goal_id?: string;
  cwd?: string;
  timeoutMs?: number;
  actor?: Partial<RuntimeControlActor>;
  replyTarget?: Partial<ChatIngressReplyTarget>;
  runtimeControl?: Partial<ChatIngressRuntimeControl>;
  companion?: {
    presence?: Partial<CompanionPresenceState>;
    turnPolicy?: Partial<CompanionTurnPolicy>;
    inputModality?: ConversationInputModality;
    outputMode?: ConversationOutputMode;
  };
  metadata?: Record<string, unknown>;
  approvalResponse?: {
    approval_id: string;
    approved: boolean;
  };
  onEvent?: ChatEventHandler;
}

export type CrossPlatformIngressMessage = ChatIngressMessage;

export interface CrossPlatformChatSessionInfo {
  session_key: string;
  identity_key?: string;
  platform?: string;
  conversation_id?: string;
  conversation_name?: string;
  user_id?: string;
  user_name?: string;
  cwd: string;
  created_at: string;
  last_used_at: string;
  last_message_id?: string;
  active_reply_target?: ChatIngressReplyTarget;
  active_companion_contract?: CompanionRuntimeContract;
  metadata: Record<string, unknown>;
}

interface ManagedChatSession {
  runner: ChatRunner;
  info: CrossPlatformChatSessionInfo;
  queue: Promise<void>;
  lastRoute?: SelectedChatRoute;
}

function normalizeIdentity(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizePlatform(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function buildSessionKeyFromParts(params: {
  identity_key?: string;
  platform?: string;
  conversation_id?: string;
  user_id?: string;
}): string {
  const identityKey = normalizeIdentity(params.identity_key);
  if (identityKey) {
    return `identity:${identityKey}`;
  }

  const platform = normalizePlatform(params.platform);
  const conversationId = normalizeIdentity(params.conversation_id);
  if (platform && conversationId) {
    return `platform:${platform}:conversation:${conversationId}`;
  }

  const userId = normalizeIdentity(params.user_id);
  if (platform && userId) {
    return `platform:${platform}:user:${userId}`;
  }

  return `ephemeral:${randomUUID()}`;
}

function buildSessionKey(options: CrossPlatformChatSessionOptions): string {
  return buildSessionKeyFromParts(options);
}

function cloneMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  return metadata ? { ...metadata } : {};
}

function buildSessionMetadata(options: {
  metadata?: Record<string, unknown>;
  platform?: string;
  conversation_id?: string;
  conversation_name?: string;
  user_id?: string;
  user_name?: string;
  channel?: ChatIngressChannel;
}): Record<string, unknown> {
  return {
    ...(options.metadata ?? {}),
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.conversation_id ? { conversation_id: options.conversation_id } : {}),
    ...(options.conversation_name ? { conversation_name: options.conversation_name } : {}),
    ...(options.user_id ? { user_id: options.user_id } : {}),
    ...(options.user_name ? { user_name: options.user_name } : {}),
  };
}

function resolveChannel(
  input: Pick<CrossPlatformIncomingChatMessage, "channel" | "platform"> | CrossPlatformChatSessionOptions
): ChatIngressChannel {
  if (input.channel) return input.channel;
  return input.platform ? "plugin_gateway" : "cli";
}

function resolveActorSurface(channel: ChatIngressChannel): RuntimeControlActor["surface"] {
  switch (channel) {
    case "plugin_gateway":
      return "gateway";
    case "cli":
      return "cli";
    case "tui":
      return "tui";
    default:
      return "chat";
  }
}

function resolveRuntimeControl(
  channel: ChatIngressChannel,
  runtimeControl: Partial<ChatIngressRuntimeControl> | undefined,
  metadata: Record<string, unknown> | undefined
): ChatIngressRuntimeControl {
  const approvalMode = runtimeControl?.approvalMode
    ?? (metadata?.["runtime_control_approved"] === true
      ? "preapproved"
      : metadata?.["runtime_control_denied"] === true
        ? "disallowed"
      : channel === "tui" || channel === "cli"
        ? "interactive"
        : "disallowed");
  return {
    allowed: runtimeControl?.allowed ?? approvalMode !== "disallowed",
    approvalMode,
  };
}

function normalizeReplyTarget(
  channel: ChatIngressChannel,
  input: {
    platform?: string;
    conversation_id?: string;
    identity_key?: string;
    user_id?: string;
    message_id?: string;
    replyTarget?: Partial<ChatIngressReplyTarget>;
    metadata?: Record<string, unknown>;
  }
): ChatIngressReplyTarget {
  const platform = normalizePlatform(input.replyTarget?.platform ?? input.platform) ?? undefined;
  const conversationId = normalizeIdentity(input.replyTarget?.conversation_id ?? input.conversation_id) ?? undefined;
  const identityKey = normalizeIdentity(input.replyTarget?.identity_key ?? input.identity_key) ?? undefined;
  const userId = normalizeIdentity(input.replyTarget?.user_id ?? input.user_id) ?? undefined;
  const messageId = normalizeIdentity(input.replyTarget?.message_id ?? input.message_id) ?? undefined;

  return {
    surface: input.replyTarget?.surface ?? resolveActorSurface(channel),
    ...(platform ? { platform } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(identityKey ? { identity_key: identityKey } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...(messageId ? { message_id: messageId } : {}),
    deliveryMode: input.replyTarget?.deliveryMode ?? "reply",
    metadata: {
      ...(input.metadata ?? {}),
      ...(input.replyTarget?.metadata ?? {}),
    },
    ...input.replyTarget,
  };
}

function normalizeActor(
  channel: ChatIngressChannel,
  input: {
    platform?: string;
    conversation_id?: string;
    identity_key?: string;
    user_id?: string;
    actor?: Partial<RuntimeControlActor>;
  }
): RuntimeControlActor {
  const platform = normalizePlatform(input.actor?.platform ?? input.platform) ?? undefined;
  const conversationId = normalizeIdentity(input.actor?.conversation_id ?? input.conversation_id) ?? undefined;
  const identityKey = normalizeIdentity(input.actor?.identity_key ?? input.identity_key) ?? undefined;
  const userId = normalizeIdentity(input.actor?.user_id ?? input.user_id) ?? undefined;

  return {
    surface: input.actor?.surface ?? resolveActorSurface(channel),
    ...(platform ? { platform } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(identityKey ? { identity_key: identityKey } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...input.actor,
  };
}

async function safeInvoke(handler: ChatEventHandler | undefined, event: ChatEvent): Promise<void> {
  if (!handler) return;
  try {
    await handler(event);
  } catch (err) {
    // Event streaming should not break chat delivery.
    console.warn("[chat] event delivery failed", {
      eventType: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

class ChatEventDeliveryQueue {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly handler: ChatEventHandler | undefined,
    private readonly upstream: ChatEventHandler | undefined
  ) {}

  dispatch = (event: ChatEvent): Promise<void> => {
    this.queue = this.queue.then(async () => {
      await safeInvoke(this.handler, event);
      if (this.upstream && this.upstream !== this.handler) {
        await safeInvoke(this.upstream, event);
      }
    });
    return this.queue;
  };

  async drain(): Promise<void> {
    await this.queue;
  }
}

export class CrossPlatformChatSessionManager {
  private readonly sessions = new Map<string, ManagedChatSession>();
  private readonly activeApprovalEventHandlers = new Map<string, ChatEventHandler>();
  private readonly approvalSideTurnIngressIds = new Set<string>();
  private readonly ingressRouter = createIngressRouter();

  constructor(private readonly deps: ChatRunnerDeps) {}

  /**
   * Execute a chat turn through a session keyed by identity_key.
   * If identity_key is absent, the manager falls back to a deterministic platform-scoped key when possible,
   * otherwise it creates an isolated one-shot session.
   */
  async execute(input: string, options: CrossPlatformChatSessionOptions = {}): Promise<ChatRunResult> {
    const ingress = this.createIngressMessage({
      text: input,
      identity_key: options.identity_key,
      platform: options.platform,
      conversation_id: options.conversation_id,
      conversation_name: options.conversation_name,
      user_id: options.user_id,
      user_name: options.user_name,
      message_id: options.message_id,
      goal_id: options.goal_id,
      channel: options.channel ?? (options.platform ? "plugin_gateway" : "cli"),
      actor: options.actor,
      replyTarget: options.replyTarget,
      runtimeControl: options.runtimeControl,
      companion: options.companion,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      metadata: {
        ...(options.metadata ?? {}),
        ...(options.runtimeControl ? { runtime_control_explicit: true } : {}),
      },
      onEvent: options.onEvent,
      userInput: options.userInput,
    });
    const approvalReply = await this.tryResolveConversationalApprovalReply(ingress);
    if (approvalReply) {
      return {
        success: true,
        output: approvalReply,
        elapsed_ms: 0,
      };
    }
    const session = this.getOrCreateSession(ingress, options.cwd);
    if (ingress.ingress_id && this.approvalSideTurnIngressIds.delete(ingress.ingress_id)) {
      return this.executeInSession(session, ingress, options);
    }
    const queueEntry = session.queue.then(() => this.executeInSession(session, ingress, options));
    session.queue = queueEntry.then(() => undefined, () => undefined);
    return queueEntry;
  }

  async processIncomingMessage(input: CrossPlatformIncomingChatMessage): Promise<string> {
    const ingress = this.createIngressMessage(input);
    if (input.approvalResponse) {
      return this.resolveConversationalApprovalIngress(ingress, input.approvalResponse);
    }
    const approvalReply = await this.tryResolveConversationalApprovalReply(ingress);
    if (approvalReply) {
      return approvalReply;
    }
    const result = await this.executeIngress(ingress, input);
    return result.output;
  }

  async interruptAndRedirect(input: CrossPlatformIncomingChatMessage): Promise<ChatRunResult> {
    const ingress = this.ensureCompanionContract(this.createIngressMessage(input));
    const approvalReply = await this.tryResolveConversationalApprovalReply(ingress);
    if (approvalReply) {
      return {
        success: true,
        output: approvalReply,
        elapsed_ms: 0,
      };
    }
    const session = this.getOrCreateSession(ingress, input.cwd);
    const decision = evaluateCompanionOutputPolicy(ingress.companion.turn_policy);
    if (!decision.delivered) {
      return {
        success: true,
        output: formatCompanionPolicyDecision(decision),
        elapsed_ms: 0,
      };
    }
    const previousOnEvent = session.runner.onEvent;
    let deliveryQueue: ChatEventDeliveryQueue | null = null;
    if (input.onEvent) {
      deliveryQueue = new ChatEventDeliveryQueue(input.onEvent, this.deps.onEvent);
      session.runner.onEvent = deliveryQueue.dispatch;
    }
    try {
      return await session.runner.interruptAndRedirect(input.text, session.info.cwd, input.timeoutMs);
    } finally {
      await deliveryQueue?.drain();
      session.runner.onEvent = previousOnEvent;
    }
  }

  async executeIngress(
    ingress: CrossPlatformIngressMessage,
    options: Pick<CrossPlatformIncomingChatMessage, "cwd" | "timeoutMs" | "onEvent" | "conversation_name" | "user_name"> = {}
  ): Promise<ChatRunResult> {
    const normalizedIngress = this.ensureCompanionContract(ingress);
    const decision = evaluateCompanionOutputPolicy(normalizedIngress.companion.turn_policy);
    if (!decision.delivered) {
      return {
        success: true,
        output: formatCompanionPolicyDecision(decision),
        elapsed_ms: 0,
      };
    }
    const session = this.getOrCreateSession(normalizedIngress, options.cwd);
    if (normalizedIngress.ingress_id && this.approvalSideTurnIngressIds.delete(normalizedIngress.ingress_id)) {
      return this.executeInSession(session, normalizedIngress, options);
    }
    const queueEntry = session.queue.then(() => this.executeInSession(session, normalizedIngress, options));
    session.queue = queueEntry.then(() => undefined, () => undefined);
    return queueEntry;
  }

  private async resolveConversationalApprovalIngress(
    ingress: CrossPlatformIngressMessage,
    response: { approval_id: string; approved: boolean }
  ): Promise<string> {
    const broker = this.deps.approvalBroker;
    if (!broker) {
      return "Approval response could not be recorded because approval handling is unavailable.";
    }
    const origin = createApprovalOriginFromIngress(ingress);
    if (!origin) {
      return "Approval response could not be recorded because the conversation origin is incomplete.";
    }
    const resolved = await broker.resolveConversationalApproval(
      response.approval_id,
      response.approved,
      origin
    );
    return resolved
      ? "Approval response recorded."
      : "Approval response did not match an active approval for this conversation.";
  }

  private async tryResolveConversationalApprovalReply(
    ingress: CrossPlatformIngressMessage
  ): Promise<string | null> {
    const broker = this.deps.approvalBroker;
    if (!broker) {
      return null;
    }
    const origin = createApprovalOriginFromIngress(ingress);
    if (!origin) {
      return null;
    }
    const lookup = await broker.findPendingConversationalApproval(origin);
    if (lookup.status === "none") {
      return null;
    }
    if (lookup.status === "ambiguous") {
      return "Multiple active approvals match this conversation. Please use the specific approval response.";
    }
    const approval = lookup.approval;

    const decision = await classifyConversationalApprovalDecision(ingress.text, {
      approval,
      replyOrigin: origin,
      llmClient: this.deps.llmClient,
      priorTurnState: this.describeLastRouteForApproval(ingress),
    });
    if (decision.decision === "approve" || decision.decision === "reject") {
      const resolved = await broker.resolveConversationalApproval(
        approval.approval_id,
        decision.decision === "approve",
        approval.origin ?? origin
      );
      return resolved
        ? "Approval response recorded."
        : "Approval response did not match an active approval for this conversation.";
    }
    if (decision.decision === "clarify") {
      return decision.clarification ?? "Approval is still pending. Please clarify what you need before approving or rejecting.";
    }
    if (decision.decision === "side_question" || decision.decision === "new_intent") {
      if (ingress.ingress_id) {
        this.approvalSideTurnIngressIds.add(ingress.ingress_id);
      }
      return null;
    }
    return decision.clarification ?? "Approval reply was ambiguous. The approval remains pending.";
  }

  private describeLastRouteForApproval(ingress: CrossPlatformIngressMessage): string {
    const session = this.sessions.get(buildSessionKeyFromParts(ingress));
    const route = session?.lastRoute;
    return route ? JSON.stringify(route) : "none";
  }

  handleIncomingMessage(input: CrossPlatformIncomingChatMessage): Promise<string> {
    return this.processIncomingMessage(input);
  }

  continueConversation(input: CrossPlatformIncomingChatMessage): Promise<string> {
    return this.processIncomingMessage(input);
  }

  processMessage(input: CrossPlatformIncomingChatMessage): Promise<string> {
    return this.processIncomingMessage(input);
  }

  private createIngressMessage(
    input: CrossPlatformIncomingChatMessage | (CrossPlatformChatSessionOptions & { text: string })
  ): CrossPlatformIngressMessage {
    const channel = resolveChannel(input);
    const metadataGoalId = typeof input.metadata?.["goal_id"] === "string"
      ? input.metadata["goal_id"].trim()
      : typeof input.metadata?.["routed_goal_id"] === "string"
        ? input.metadata["routed_goal_id"].trim()
        : "";
    const goalId = normalizeIdentity(input.goal_id ?? metadataGoalId) ?? undefined;
    const metadata: Record<string, unknown> = {
      ...(input.metadata ?? {}),
      ...(goalId ? { goal_id: goalId } : {}),
      ...("sender_id" in input && input.sender_id ? { sender_id: input.sender_id } : {}),
      ...(input.message_id ? { message_id: input.message_id } : {}),
    };
    const userId = normalizeIdentity(input.user_id ?? ("sender_id" in input ? input.sender_id : undefined)) ?? undefined;
    const platform = normalizePlatform(input.platform) ?? undefined;
    const identityKey = normalizeIdentity(input.identity_key) ?? undefined;
    const conversationId = normalizeIdentity(input.conversation_id) ?? undefined;
    const messageId = normalizeIdentity(input.message_id) ?? undefined;
    const companion = this.buildCompanionContractForIngress({
      identity_key: identityKey,
      platform,
      conversation_id: conversationId,
      user_id: userId,
      message_id: messageId,
      goal_id: goalId,
      replyTarget: input.replyTarget,
      companion: input.companion,
    });

    return {
      ingress_id: randomUUID(),
      received_at: new Date().toISOString(),
      channel,
      ...(platform ? { platform } : {}),
      ...(identityKey ? { identity_key: identityKey } : {}),
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(messageId ? { message_id: messageId } : {}),
      ...(goalId ? { goal_id: goalId } : {}),
      ...(userId ? { user_id: userId } : {}),
      text: input.text,
      userInput: normalizeUserInput(input.userInput, input.text),
      actor: normalizeActor(channel, {
        platform,
        conversation_id: conversationId,
        identity_key: identityKey,
        user_id: userId,
        actor: input.actor,
      }),
      runtimeControl: resolveRuntimeControl(channel, input.runtimeControl, metadata),
      companion,
      metadata,
      replyTarget: normalizeReplyTarget(channel, {
        platform,
        conversation_id: conversationId,
        identity_key: identityKey,
        user_id: userId,
        message_id: messageId,
        replyTarget: input.replyTarget,
        metadata,
      }),
    };
  }

  private ensureCompanionContract(ingress: CrossPlatformIngressMessage): CrossPlatformIngressMessage & { companion: CompanionRuntimeContract } {
    if (ingress.companion) {
      return ingress as CrossPlatformIngressMessage & { companion: CompanionRuntimeContract };
    }
    return {
      ...ingress,
      companion: this.buildCompanionContractForIngress({
        identity_key: ingress.identity_key,
        platform: ingress.platform,
        conversation_id: ingress.conversation_id,
        user_id: ingress.user_id,
        message_id: ingress.message_id,
        goal_id: ingress.goal_id,
        replyTarget: ingress.replyTarget,
      }),
    };
  }

  private buildCompanionContractForIngress(input: {
    identity_key?: string;
    platform?: string;
    conversation_id?: string;
    user_id?: string;
    message_id?: string;
    goal_id?: string;
    replyTarget?: Partial<ChatIngressReplyTarget>;
    companion?: CrossPlatformIncomingChatMessage["companion"];
  }): CompanionRuntimeContract {
    const sessionKey = buildSessionKeyFromParts({
      identity_key: input.identity_key,
      platform: input.platform,
      conversation_id: input.conversation_id,
      user_id: input.user_id,
    });
    const replyTargetId = normalizeIdentity(input.replyTarget?.conversation_id ?? input.conversation_id ?? input.replyTarget?.identity_key ?? input.identity_key) ?? undefined;
    return buildCompanionRuntimeContract({
      sessionKey,
      conversationId: input.conversation_id,
      messageId: input.message_id,
      goalId: input.goal_id,
      replyTargetId,
      presence: input.companion?.presence,
      turnPolicy: input.companion?.turnPolicy,
      inputModality: input.companion?.inputModality ?? "text",
      outputMode: input.companion?.outputMode,
    });
  }

  /**
   * Returns the active session info if a matching session is already loaded.
   */
  getSessionInfo(options: CrossPlatformChatSessionOptions): CrossPlatformChatSessionInfo | null {
    const sessionKey = buildSessionKey(options);
    const session = this.sessions.get(sessionKey);
    return session
      ? {
          ...session.info,
          metadata: cloneMetadata(session.info.metadata),
          active_reply_target: session.info.active_reply_target
            ? {
                ...session.info.active_reply_target,
                metadata: cloneMetadata(session.info.active_reply_target.metadata),
              }
            : undefined,
        }
      : null;
  }

  private getOrCreateSession(
    ingress: Pick<ChatIngressMessage, "identity_key" | "platform" | "conversation_id" | "user_id">,
    cwdOverride?: string
  ): ManagedChatSession {
    const sessionKey = buildSessionKeyFromParts(ingress);
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return existing;
    }

    const cwd = resolveGitRoot(cwdOverride?.trim() || process.cwd());
    const now = new Date().toISOString();
    const info: CrossPlatformChatSessionInfo = {
      session_key: sessionKey,
      identity_key: normalizeIdentity(ingress.identity_key) ?? undefined,
      platform: normalizePlatform(ingress.platform) ?? undefined,
      conversation_id: normalizeIdentity(ingress.conversation_id) ?? undefined,
      user_id: normalizeIdentity(ingress.user_id) ?? undefined,
      cwd,
      created_at: now,
      last_used_at: now,
      metadata: {},
    };
    const approvalFn = this.createApprovalFn(info);
    const runner = new ChatRunner({
      ...this.deps,
      approvalFn: approvalFn ?? this.deps.approvalFn,
      runtimeControlApprovalFn: approvalFn ?? this.deps.runtimeControlApprovalFn,
    });
    runner.startSession(cwd);

    const created: ManagedChatSession = {
      runner,
      info,
      queue: Promise.resolve(),
      lastRoute: undefined,
    };
    this.sessions.set(sessionKey, created);
    return created;
  }

  private createApprovalFn(info: CrossPlatformChatSessionInfo): ((description: string) => Promise<boolean>) | null {
    const broker = this.deps.approvalBroker;
    if (!broker) {
      return null;
    }
    return async (description: string) => {
      const origin = createApprovalOriginFromSessionInfo(info);
      if (!origin) {
        return false;
      }
      const goalId = typeof info.metadata.goal_id === "string" && info.metadata.goal_id.trim()
        ? info.metadata.goal_id.trim()
        : "chat";
      return broker.requestConversationalApproval(goalId, {
        id: info.last_message_id ?? info.session_key,
        description,
        action: "chat_approval",
      }, {
        origin,
        deliverConversationalApproval: async ({ prompt }) => {
          const handler = this.activeApprovalEventHandlers.get(info.session_key);
          if (!handler) {
            return {
              delivered: false,
              reason: "originating_conversation_unreachable",
            };
          }
          try {
            await handler({
              type: "activity",
              kind: "checkpoint",
              message: prompt,
              sourceId: `approval:${info.last_message_id ?? info.session_key}`,
              runId: info.session_key,
              turnId: info.last_message_id ?? info.session_key,
              createdAt: new Date().toISOString(),
            });
            return { delivered: true };
          } catch (err) {
            return {
              delivered: false,
              reason: err instanceof Error ? err.message : "originating_conversation_unreachable",
            };
          }
        },
      });
    };
  }

  private async executeInSession(
    session: ManagedChatSession,
    ingress: CrossPlatformIngressMessage,
    options: Pick<CrossPlatformIncomingChatMessage, "timeoutMs" | "onEvent" | "conversation_name" | "user_name"> = {}
  ): Promise<ChatRunResult> {
    session.info.last_used_at = new Date().toISOString();
    session.info.conversation_name = options.conversation_name?.trim() || session.info.conversation_name;
    session.info.user_id = session.info.user_id ?? (normalizeIdentity(ingress.user_id) ?? undefined);
    session.info.user_name = options.user_name?.trim() || session.info.user_name;
    session.info.last_message_id = normalizeIdentity(ingress.message_id) ?? session.info.last_message_id;
    session.info.active_reply_target = {
      ...ingress.replyTarget,
      metadata: cloneMetadata(ingress.replyTarget.metadata),
    };
    if (ingress.companion) {
      session.info.active_companion_contract = ingress.companion;
    }
    session.info.metadata = cloneMetadata(buildSessionMetadata({
      metadata: ingress.metadata,
      channel: ingress.channel,
      platform: ingress.platform,
      conversation_id: ingress.conversation_id,
      conversation_name: options.conversation_name,
      user_id: ingress.user_id,
      user_name: options.user_name,
    }));

    const capabilities = {
      hasAgentLoop: this.deps.chatAgentLoopRunner !== undefined,
      hasToolLoop: this.deps.llmClient !== undefined,
      hasRuntimeControlService: this.deps.runtimeControlService !== undefined,
    };
    const setupSecretIntake = intakeSetupSecrets(ingress.text);
    const safeIngressText = setupSecretIntake.redactedText;
    const hasSetupSecret = setupSecretIntake.suppliedSecrets.length > 0;
    const shouldPreferFreeformBeforeDeniedRuntimeControl =
      !hasSetupSecret
      && !capabilities.hasAgentLoop
      && ingress.metadata["runtime_control_denied"] === true
      && ingress.metadata["runtime_control_approved"] !== true
      && ingress.metadata["runtime_control_explicit"] !== true;
    const shouldClassifyRuntimeControlForSafety =
      !hasSetupSecret
      && capabilities.hasAgentLoop
      && (
        ingress.metadata["runtime_control_approved"] === true
        || ingress.metadata["runtime_control_denied"] === true
        || ingress.metadata["runtime_control_explicit"] === true
      );
    const shouldClassifyRuntimeControl =
      shouldClassifyRuntimeControlForSafety
      || (!hasSetupSecret && !capabilities.hasAgentLoop && (
        (capabilities.hasRuntimeControlService && ingress.runtimeControl.approvalMode !== "disallowed")
        || ingress.metadata["runtime_control_approved"] === true
        || ingress.metadata["runtime_control_denied"] === true
        || ingress.metadata["runtime_control_explicit"] === true
      ));
    let freeformRouteIntent = shouldPreferFreeformBeforeDeniedRuntimeControl
      ? await classifyFreeformRouteIntent(safeIngressText, this.deps.llmClient)
      : null;
    const runtimeControlClassification = freeformRouteIntent == null && shouldClassifyRuntimeControl
      ? await classifyRuntimeControlIntent(safeIngressText, this.deps.llmClient)
      : null;
    const runtimeControlIntent = runtimeControlClassification?.status === "intent"
      ? runtimeControlClassification.intent
      : null;
    if (!hasSetupSecret && !capabilities.hasAgentLoop && freeformRouteIntent == null && runtimeControlIntent === null) {
      freeformRouteIntent = await classifyFreeformRouteIntent(safeIngressText, this.deps.llmClient);
    }
    const shouldDeriveRunSpecDraft =
      !capabilities.hasAgentLoop
      && !hasSetupSecret
      && runtimeControlIntent === null
      && freeformRouteIntent != null
      && (
        freeformRouteIntent.kind === "run_spec"
        || freeformRouteIntent.kind === "configure"
        || freeformRouteIntent.kind === "clarify"
      )
      && freeformRouteIntent.confidence >= 0.7;
    const runSpecDraft = shouldDeriveRunSpecDraft
      ? await deriveRunSpecFromText(safeIngressText, {
        cwd: ingress.cwd ?? session.info.cwd,
        conversationId: ingress.conversation_id ?? null,
        channel: ingress.channel,
        sessionId: session.runner.getSessionId() ?? ingress.conversation_id ?? null,
        replyTarget: ingress.replyTarget as unknown as Record<string, unknown>,
        originMetadata: {
          ingress_id: ingress.ingress_id ?? null,
          platform: ingress.platform ?? null,
          message_id: ingress.message_id ?? null,
          deliveryMode: ingress.deliveryMode ?? null,
          metadata: ingress.metadata,
        },
        llmClient: this.deps.llmClient,
      })
      : null;
    const selectedRoute = this.ingressRouter.selectRoute(ingress, {
      ...capabilities,
      runtimeControlIntent,
      runtimeControlUnclassified: shouldClassifyRuntimeControlForSafety
        && runtimeControlClassification?.status === "unclassified"
        && ingress.metadata["runtime_control_explicit"] === true,
      freeformRouteIntent,
      setupSecretIntake,
      runSpecDraft,
    });
    session.lastRoute = selectedRoute;

    const previousOnEvent = session.runner.onEvent;
    let deliveryQueue: ChatEventDeliveryQueue | null = null;
    if (options.onEvent) {
      deliveryQueue = new ChatEventDeliveryQueue(options.onEvent, this.deps.onEvent);
      this.activeApprovalEventHandlers.set(session.info.session_key, options.onEvent);
      session.runner.onEvent = deliveryQueue.dispatch;
    } else {
      this.activeApprovalEventHandlers.delete(session.info.session_key);
      session.runner.onEvent = undefined;
    }

    try {
      return await session.runner.executeIngressMessage(
        ingress,
        session.info.cwd,
        options.timeoutMs,
        selectedRoute
      );
    } finally {
      await deliveryQueue?.drain();
      this.activeApprovalEventHandlers.delete(session.info.session_key);
      session.runner.onEvent = previousOnEvent;
    }
  }
}

function formatCompanionPolicyDecision(decision: ReturnType<typeof evaluateCompanionOutputPolicy>): string {
  if (decision.reason === "interruption_requires_explicit_request") {
    return "The current companion turn is non-interruptible. Send an explicit interruption request before redirecting it.";
  }
  if (decision.reason === "suppressed_by_quieting") {
    return "Companion output was suppressed by the current quieting policy.";
  }
  if (decision.reason === "deferred_by_quieting") {
    return "Companion output was deferred by the current quieting policy.";
  }
  return "Companion output is allowed.";
}

export function createApprovalOriginFromSessionInfo(
  info: CrossPlatformChatSessionInfo
): ApprovalOrigin | null {
  const replyTarget = info.active_reply_target;
  const channel = normalizeIdentity(
    replyTarget?.platform
    ?? replyTarget?.channel
    ?? replyTarget?.surface
    ?? info.platform
  );
  const conversationId = normalizeIdentity(
    replyTarget?.conversation_id
    ?? info.conversation_id
    ?? info.identity_key
    ?? info.session_key
  );
  if (!channel || !conversationId) {
    return null;
  }
  const userId = normalizeIdentity(replyTarget?.user_id ?? info.user_id) ?? undefined;
  const turnId = normalizeIdentity(replyTarget?.message_id ?? info.last_message_id) ?? undefined;
  return {
    channel,
    conversation_id: conversationId,
    ...(userId ? { user_id: userId } : {}),
    session_id: info.session_key,
    ...(turnId ? { turn_id: turnId } : {}),
    reply_target: {
      ...replyTarget,
      metadata: replyTarget?.metadata ? { ...replyTarget.metadata } : undefined,
    },
  };
}

function createApprovalOriginFromIngress(
  ingress: CrossPlatformIngressMessage
): ApprovalOrigin | null {
  const channel = normalizeIdentity(
    ingress.replyTarget.platform
    ?? ingress.replyTarget.channel
    ?? ingress.replyTarget.surface
    ?? ingress.platform
  );
  const conversationId = normalizeIdentity(
    ingress.replyTarget.conversation_id
    ?? ingress.conversation_id
    ?? ingress.identity_key
  );
  const userId = normalizeIdentity(ingress.replyTarget.user_id ?? ingress.user_id) ?? undefined;
  const turnId = normalizeIdentity(ingress.replyTarget.message_id ?? ingress.message_id) ?? undefined;
  if (!channel || !conversationId || !userId || !turnId) {
    return null;
  }
  return {
    channel,
    conversation_id: conversationId,
    user_id: userId,
    session_id: buildSessionKeyFromParts(ingress),
    turn_id: turnId,
    reply_target: {
      ...ingress.replyTarget,
      metadata: cloneMetadata(ingress.replyTarget.metadata),
    },
  };
}

let globalManagerPromise: Promise<CrossPlatformChatSessionManager> | null = null;

export function getGlobalCrossPlatformChatSessionManager(): Promise<CrossPlatformChatSessionManager> {
  if (globalManagerPromise === null) {
    globalManagerPromise = createGlobalCrossPlatformChatSessionManager().catch((err) => {
      globalManagerPromise = null;
      throw err;
    });
  }
  return globalManagerPromise;
}

async function createGlobalCrossPlatformChatSessionManager(): Promise<CrossPlatformChatSessionManager> {
  const providerConfig = await loadProviderConfig();
  const stateManager = new StateManager();
  await stateManager.init();

  const llmClient = await buildLLMClient();
  const adapterRegistry = await buildAdapterRegistry(llmClient, providerConfig);
  const adapter = adapterRegistry.getAdapter(providerConfig.adapter);
  const toolRegistry = new ToolRegistry();
  const trustManager = new TrustManager(stateManager);
  const dataSourceRegistry = await buildCliDataSourceRegistry();
  const observationEngine = new ObservationEngine(
    stateManager,
    dataSourceRegistry.getAllSources(),
    llmClient,
  );
  const knowledgeManager = new KnowledgeManager(stateManager, llmClient);
  const goalDependencyGraph = new GoalDependencyGraph(stateManager, llmClient);
  await goalDependencyGraph.init();
  const sessionManager = new SessionManager(stateManager, goalDependencyGraph);
  const scheduleEngine = new ScheduleEngine({
    baseDir: stateManager.getBaseDir(),
    dataSourceRegistry,
    llmClient,
    stateManager,
    knowledgeManager,
  });
  await scheduleEngine.loadEntries();
  const pluginLoader = new PluginLoader(
    adapterRegistry,
    dataSourceRegistry,
    new NotifierRegistry(),
    undefined,
    undefined,
    (dataSource) => {
      if (!observationEngine.getDataSources().some((source) => source.sourceId === dataSource.sourceId)) {
        observationEngine.addDataSource(dataSource);
      }
    }
  );
  await pluginLoader.loadAll().catch(() => []);
  await scheduleEngine.syncExternalSources(pluginLoader.getScheduleSources()).catch(() => undefined);
  const runtimeRoot = path.join(stateManager.getBaseDir(), "runtime");
  const runtimeControlService = new RuntimeControlService({
    runtimeRoot,
    stateManager,
    executor: createDaemonRuntimeControlExecutor({
      baseDir: stateManager.getBaseDir(),
    }),
  });

  for (const tool of createBuiltinTools({
    stateManager,
    trustManager,
    registry: toolRegistry,
    llmClient,
    runtimeControlService,
    adapterRegistry,
    knowledgeManager,
    observationEngine,
    sessionManager,
    scheduleEngine,
    pluginLoader,
  })) {
    toolRegistry.register(tool);
  }

  const toolExecutor = new ToolExecutor({
    registry: toolRegistry,
    permissionManager: new ToolPermissionManager({ trustManager }),
    concurrency: new ConcurrencyController(),
  });

  const chatAgentLoopRunner = shouldUseNativeTaskAgentLoop(providerConfig, llmClient)
    ? createNativeChatAgentLoopRunner({
        llmClient,
        providerConfig,
        toolRegistry,
        toolExecutor,
        traceBaseDir: stateManager.getBaseDir(),
      })
    : undefined;
  const reviewAgentLoopRunner = shouldUseNativeTaskAgentLoop(providerConfig, llmClient)
    ? createNativeReviewAgentLoopRunner({
        llmClient,
        providerConfig,
        toolRegistry,
        toolExecutor,
        traceBaseDir: stateManager.getBaseDir(),
      })
    : undefined;

  const approvalBroker = new ApprovalBroker({
    store: new ApprovalStore(createRuntimeStorePaths(runtimeRoot)),
  });

  return new CrossPlatformChatSessionManager({
    stateManager,
    adapter,
    llmClient,
    registry: toolRegistry,
    toolExecutor,
    chatAgentLoopRunner,
    reviewAgentLoopRunner,
    approvalBroker,
    runtimeControlService,
  });
}

registerGlobalCrossPlatformChatSessionManager(getGlobalCrossPlatformChatSessionManager);
