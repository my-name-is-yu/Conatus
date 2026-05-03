// ─── ChatRunner ───
//
// Central coordinator for 1-shot chat execution (Tier 1).
// Bypasses TaskLifecycle — calls adapter.execute() directly.

import { randomUUID } from "node:crypto";
import type { StateManager } from "../../base/state/state-manager.js";
import type { IAdapter } from "../../orchestrator/execution/adapter-layer.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import { getPulseedDirPath } from "../../base/utils/paths.js";
import { getGatewayChannelDir } from "../../base/utils/paths.js";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../base/utils/json-io.js";
import { getSelfIdentityResponseForBaseDir } from "../../base/config/identity-loader.js";
import { ChatHistory, type ChatSession } from "./chat-history.js";
import {
  ChatSessionCatalog,
  ChatSessionSelectorError,
  type LoadedChatSession,
} from "./chat-session-store.js";
import { buildChatContext, resolveGitRoot } from "../../platform/observation/context-provider.js";
import type { EscalationHandler } from "./escalation.js";
import { buildChatAgentLoopSystemPrompt, buildStaticSystemPrompt, createChatGroundingGateway } from "./grounding.js";
import type { GroundingGateway } from "../../grounding/gateway.js";
import type { ApprovalLevel } from "./mutation-tool-defs.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { ToolExecutor } from "../../tools/executor.js";
import type { DaemonClient } from "../../runtime/daemon/client.js";
import type { GatewaySetupStatusProvider } from "./gateway-setup-status.js";
import type { GoalNegotiator } from "../../orchestrator/goal/goal-negotiator.js";
import type { ChatEventHandler } from "./chat-events.js";
import type { ChatAgentLoopRunner } from "../../orchestrator/execution/agent-loop/chat-agent-loop-runner.js";
import type { ReviewAgentLoopRunner } from "../../orchestrator/execution/agent-loop/review-agent-loop-runner.js";
import type { RuntimeControlService } from "../../runtime/control/index.js";
import type { ApprovalBroker } from "../../runtime/approval-broker.js";
import { recognizeRuntimeControlIntent } from "../../runtime/control/index.js";
import { classifyConfirmationDecision } from "../../runtime/confirmation-decision.js";
import type {
  RuntimeControlActor,
  RuntimeControlReplyTarget,
} from "../../runtime/store/runtime-operation-schemas.js";
import type { RuntimeReplyTarget } from "../../runtime/session-registry/types.js";
import type { ExecutionPolicy } from "../../orchestrator/execution/agent-loop/execution-policy.js";
import { GoalSchema, type Goal } from "../../base/types/goal.js";
import { BackgroundRunLedger, type BackgroundRunCreateInput } from "../../runtime/store/background-run-store.js";
import { resolveConfiguredDaemonRuntimeRoot } from "../../runtime/daemon/runtime-root.js";
import {
  createIngressRouter,
  type ChatIngressMessage,
  type SelectedChatRoute,
} from "./ingress-router.js";
import { classifyInterruptRedirect, collectGitDiffArtifact, previewActivityText } from "./chat-runner-support.js";
import {
  COMMAND_HELP,
  ChatRunnerCommandHandler,
  type PendingTendState,
} from "./chat-runner-commands.js";
import { ChatRunnerEventBridge, type AssistantBuffer } from "./chat-runner-event-bridge.js";
import { intakeSetupSecrets } from "./setup-secret-intake.js";
import {
  isSetupWriteConfirmCommand,
  SETUP_WRITE_CONFIRM_COMMAND,
  type SetupDialogueRuntimeState,
} from "./setup-dialogue.js";
import {
  detectTurnLanguageHint,
  sameLanguageResponseInstruction,
  UNKNOWN_TURN_LANGUAGE_HINT,
  type TurnLanguageHint,
} from "./turn-language.js";
import type { TelegramGatewayConfig } from "../../runtime/gateway/telegram-gateway-adapter.js";
import {
  buildRuntimeControlContextFromIngress,
  buildStandaloneIngressMessageFromContext,
  formatRoute,
  getRouteCapabilities,
  loadedSessionToChatSession,
  resolveChatResumeSelector,
} from "./chat-runner-runtime.js";
import {
  executeAdapterRoute,
  executeAssistRoute,
  executeClarifyRoute,
  executeConfigureRoute,
  executeRunSpecDraftRoute,
  executeAgentLoopRoute,
  formatBlockedRuntimeControlRoute,
  executeRuntimeControlRoute,
  executeToolLoopRoute,
  resolveSessionExecutionPolicy,
} from "./chat-runner-routes.js";
import { classifyFreeformRouteIntent } from "./freeform-route-classifier.js";
import { deriveRunSpecFromText } from "../../runtime/run-spec/index.js";
import {
  createRunSpecStore,
  formatRunSpecSetupProposal,
  handleRunSpecConfirmationInput,
  type RunSpec,
} from "../../runtime/run-spec/index.js";

export interface ChatRunnerDeps {
  stateManager: StateManager;
  adapter: IAdapter;
  llmClient?: ILLMClient;
  escalationHandler?: EscalationHandler;
  trustManager?: { getBalance(domain: string): Promise<{ balance: number }>; setOverride?(domain: string, balance: number, reason: string): Promise<void> };
  pluginLoader?: { loadAll(): Promise<Array<{ name: string; type?: string; enabled?: boolean }>> };
  approvalFn?: (description: string) => Promise<boolean>;
  goalId?: string;
  approvalConfig?: Record<string, ApprovalLevel>;
  toolExecutor?: ToolExecutor;
  registry?: ToolRegistry;
  onToolStart?: (toolName: string, args: Record<string, unknown>) => void;
  onToolEnd?: (toolName: string, result: { success: boolean; summary: string; durationMs: number }) => void;
  daemonClient?: DaemonClient;
  goalNegotiator?: GoalNegotiator;
  onNotification?: (message: string) => void;
  daemonBaseUrl?: string;
  onEvent?: ChatEventHandler;
  chatAgentLoopRunner?: ChatAgentLoopRunner;
  reviewAgentLoopRunner?: Pick<ReviewAgentLoopRunner, "execute">;
  runtimeControlService?: Pick<RuntimeControlService, "request">;
  approvalBroker?: Pick<
    ApprovalBroker,
    "requestConversationalApproval" | "resolveConversationalApproval" | "findPendingConversationalApproval"
  >;
  runtimeControlApprovalFn?: (description: string) => Promise<boolean>;
  runtimeReplyTarget?: RuntimeControlReplyTarget;
  runtimeControlActor?: RuntimeControlActor;
  gatewaySetupStatusProvider?: GatewaySetupStatusProvider;
}

export interface ChatRunResult {
  success: boolean;
  output: string;
  elapsed_ms: number;
}

export interface RuntimeControlChatContext {
  replyTarget?: RuntimeControlReplyTarget;
  actor?: RuntimeControlActor;
  approvalFn?: (description: string) => Promise<boolean>;
}

export interface ChatRunnerExecutionOptions {
  selectedRoute?: SelectedChatRoute;
  runtimeControlContext?: RuntimeControlChatContext | null;
  goalId?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function normalizePinnedReplyTarget(replyTarget: RuntimeControlReplyTarget | null): RuntimeReplyTarget | null {
  if (!replyTarget) return null;
  const channel = replyTarget.channel ?? replyTarget.surface;
  if (!channel) return null;
  return {
    channel,
    target_id: replyTarget.conversation_id ?? replyTarget.identity_key ?? replyTarget.response_channel ?? null,
    thread_id: replyTarget.message_id ?? null,
    metadata: {
      ...replyTarget,
      ...(replyTarget.metadata ?? {}),
    },
  };
}

function normalizePinnedReplyTargetForRunSpec(replyTarget: RuntimeControlReplyTarget | null): RuntimeReplyTarget | null {
  if (!replyTarget) return null;
  const channel = replyTarget.channel ?? replyTarget.surface;
  if (!channel) return null;
  return {
    channel,
    target_id: replyTarget.conversation_id ?? replyTarget.identity_key ?? replyTarget.response_channel ?? null,
    thread_id: replyTarget.message_id ?? null,
    metadata: {
      ...replyTarget,
      ...(replyTarget.metadata ?? {}),
    },
  };
}

function goalDimensionFromRunSpec(spec: RunSpec, now: string): Goal["dimensions"][number] {
  const metric = spec.metric;
  const progress = spec.progress_contract;
  const thresholdValue = metric?.target ?? metric?.target_rank_percent ?? progress.threshold;
  const direction = metric?.direction ?? "unknown";
  const threshold = typeof thresholdValue === "number"
    ? direction === "minimize"
      ? { type: "max" as const, value: thresholdValue }
      : { type: "min" as const, value: thresholdValue }
    : { type: "present" as const };
  return {
    name: progress.dimension ?? metric?.name ?? "runspec_progress",
    label: progress.semantics,
    current_value: null,
    threshold,
    confidence: spec.confidence === "high" ? 0.85 : spec.confidence === "medium" ? 0.65 : 0.4,
    observation_method: {
      type: "llm_review",
      source: "natural_language_runspec",
      schedule: null,
      endpoint: null,
      confidence_tier: "self_report",
    },
    last_updated: now,
    history: [],
    weight: 1,
    uncertainty_weight: null,
    state_integrity: "ok",
    dimension_mapping: null,
  };
}

function goalConstraintsFromRunSpec(spec: RunSpec): string[] {
  return [
    `RunSpec: ${spec.id}`,
    `Profile: ${spec.profile}`,
    `Workspace: ${spec.workspace?.path ?? "unresolved"}`,
    `Progress: ${spec.progress_contract.semantics}`,
    `Submit policy: ${spec.approval_policy.submit}`,
    `Publish policy: ${spec.approval_policy.publish}`,
    `External actions: ${spec.approval_policy.external_action}`,
    `Secret policy: ${spec.approval_policy.secret}`,
    `Irreversible actions: ${spec.approval_policy.irreversible_action}`,
  ];
}

function validateRunSpecStartSafety(spec: RunSpec): string | null {
  const required = spec.missing_fields.filter((field) => field.severity === "required");
  if (required.length > 0) {
    return [
      `RunSpec confirmed but not started: ${spec.id}`,
      "Required RunSpec details are unresolved.",
      ...required.map((field) => `- ${field.question}`),
      "Reply with the missing workspace, deadline, metric, or approval details, then approve again.",
    ].join("\n");
  }

  if (!spec.workspace?.path || spec.workspace.confidence === "low") {
    return [
      `RunSpec confirmed but not started: ${spec.id}`,
      "Workspace is missing or ambiguous.",
      "Reply with the exact local or remote workspace path before starting background CoreLoop work.",
    ].join("\n");
  }

  const blockedPolicies = [
    spec.approval_policy.submit === "disallowed" ? "submit" : null,
    spec.approval_policy.publish === "disallowed" ? "publish" : null,
    spec.approval_policy.external_action === "disallowed" ? "external action" : null,
    spec.approval_policy.irreversible_action === "disallowed" ? "irreversible action" : null,
    spec.approval_policy.secret === "disallowed" ? "secret transmission" : null,
  ].filter((value): value is string => value !== null);
  if (blockedPolicies.length > 0) {
    return [
      `RunSpec confirmed but not started: ${spec.id}`,
      `Blocked safety policy: ${blockedPolicies.join(", ")}.`,
      "PulSeed will not start a long-running handoff that requires a disallowed external, secret, production, destructive, or irreversible action.",
      "Revise the RunSpec to remove the blocked action or mark it approval-required for a later explicit approval gate.",
    ].join("\n");
  }

  return null;
}
const standaloneIngressRouter = createIngressRouter();

function resolveSelfIdentityResponse(input: string, baseDir: string): string | null {
  const normalized = input.trim().toLowerCase().replace(/\s+/g, "");
  if (!normalized) return null;

  const isEnglishIdentityQuestion = /^(whoareyou|whatisyourname|what'syourname)[?]?$/.test(normalized);
  const isIdentityQuestion = [
    /^(あなた|君|きみ|お前|おまえ)(は|って)?(誰|だれ|何者|なにもの)(ですか|なの|です)?[？?]?$/,
    /^(あなた|君|きみ|お前|おまえ)の名前(は|って)?(何|なに)(ですか|なの|です)?[？?]?$/,
    /^名前(は|って)?(何|なに)(ですか|なの|です)?[？?]?$/,
  ].some((pattern) => pattern.test(normalized));

  if (!isIdentityQuestion && !isEnglishIdentityQuestion) return null;
  return getSelfIdentityResponseForBaseDir(baseDir, isEnglishIdentityQuestion ? "en" : "ja");
}

function formatPendingSetupConfirmationSubject(publicState: SetupDialogueRuntimeState["publicState"]): string {
  const lines = [
    `Setup dialogue: ${publicState.selectedChannel}`,
    `State: ${publicState.state}`,
    `Action: ${publicState.action?.kind ?? "unknown"}`,
    `Command fallback: ${publicState.action?.command ?? SETUP_WRITE_CONFIRM_COMMAND}`,
    publicState.replacesExistingSecret
      ? "Confirming will replace an existing configured Telegram bot token."
      : "Confirming will write a Telegram gateway config from a redacted chat-supplied token.",
    "Approval is still required before writing config.",
  ];
  return lines.join("\n");
}

function formatSetupConfirmationCancelled(languageHint: TurnLanguageHint): string {
  if (languageHint.language === "ja") {
    return "Telegram setup の config write はキャンセルしました。token は書き込んでいません。";
  }
  return "Telegram setup config write was cancelled. No token was written.";
}

function formatTelegramSetupRefreshResult(
  result: { success: boolean; message: string; operationId?: string; state?: string; unavailable?: boolean },
  languageHint: TurnLanguageHint
): string {
  if (result.success) {
    const suffix = result.operationId ? ` (${result.operationId})` : "";
    return languageHint.language === "ja"
      ? `PulSeed は更新済み Telegram gateway config を反映するため、internal gateway refresh を要求しました${suffix}: ${result.message}`
      : `PulSeed requested an internal gateway refresh for the updated Telegram config${suffix}: ${result.message}`;
  }
  if (result.unavailable) {
    return languageHint.language === "ja"
      ? `PulSeed は internal gateway refresh を試みましたが、この chat surface では runtime control service が利用できません: ${result.message}`
      : `PulSeed attempted an internal gateway refresh, but runtime control is unavailable in this chat surface: ${result.message}`;
  }
  return languageHint.language === "ja"
    ? `PulSeed は internal gateway refresh を試みましたが失敗しました: ${result.message}`
    : `PulSeed attempted an internal gateway refresh, but it failed: ${result.message}`;
}

export class ChatRunner {
  private readonly groundingGateway: GroundingGateway;
  private readonly eventBridge: ChatRunnerEventBridge;
  private readonly commandHandler: ChatRunnerCommandHandler;
  private history: ChatHistory | null = null;
  private sessionCwd: string | null = null;
  private sessionActive = false;
  private activatedTools: Set<string> = new Set();
  private cachedStaticSystemPrompt: string | null = null;
  private pendingTend: PendingTendState | null = null;
  private activeSubscribers = new Map<string, { unsubscribe(): void }>();
  onNotification: ((message: string) => void) | undefined = undefined;
  onEvent: ChatEventHandler | undefined = undefined;
  private nativeAgentLoopStatePath: string | null = null;
  private runtimeControlContext: RuntimeControlChatContext | null = null;
  private sessionExecutionPolicy: ExecutionPolicy | null = null;
  private lastSelectedRoute: SelectedChatRoute | null = null;
  private setupSecretIntake: ReturnType<typeof intakeSetupSecrets> | null = null;
  private turnLanguageHint: TurnLanguageHint = UNKNOWN_TURN_LANGUAGE_HINT;
  private pendingSetupDialogue: SetupDialogueRuntimeState | null = null;

  constructor(private readonly deps: ChatRunnerDeps) {
    this.groundingGateway = createChatGroundingGateway({
      stateManager: deps.stateManager,
      pluginLoader: deps.pluginLoader,
    });
    this.eventBridge = new ChatRunnerEventBridge(() => this.onEvent ?? this.deps.onEvent);
    this.commandHandler = new ChatRunnerCommandHandler({
      deps: this.deps,
      onNotification: this.onNotification,
      getHistory: () => this.history,
      setHistory: (history) => { this.history = history; },
      getSessionCwd: () => this.sessionCwd,
      setSessionCwd: (cwd) => { this.sessionCwd = cwd; },
      setSessionActive: (active) => { this.sessionActive = active; },
      getNativeAgentLoopStatePath: () => this.nativeAgentLoopStatePath,
      setNativeAgentLoopStatePath: (path) => { this.nativeAgentLoopStatePath = path; },
      getRuntimeControlContext: () => this.runtimeControlContext,
      getPendingTend: () => this.pendingTend,
      setPendingTend: (value) => { this.pendingTend = value; },
      getLastSelectedRoute: () => this.lastSelectedRoute,
      getSessionExecutionPolicy: () => this.getSessionExecutionPolicy(),
      emitEvent: (event) => this.eventBridge.emitEvent(event),
      getActiveSubscribers: () => this.activeSubscribers as Map<string, never>,
      setSessionExecutionPolicy: (policy: ExecutionPolicy) => { this.sessionExecutionPolicy = policy; },
      resetSessionExecutionPolicy: () => { this.sessionExecutionPolicy = null; },
    } as ConstructorParameters<typeof ChatRunnerCommandHandler>[0]);
  }

  startSession(cwd: string): void {
    const gitRoot = resolveGitRoot(cwd);
    const sessionId = crypto.randomUUID();
    this.history = new ChatHistory(this.deps.stateManager, sessionId, gitRoot);
    this.sessionCwd = gitRoot;
    this.sessionActive = true;
    this.nativeAgentLoopStatePath = `chat/agentloop/${sessionId}.state.json`;
    this.history.resetAgentLoopState(this.nativeAgentLoopStatePath);
    this.sessionExecutionPolicy = null;
  }

  startSessionFromLoadedSession(session: LoadedChatSession): void {
    const chatSession = loadedSessionToChatSession(session);
    this.history = ChatHistory.fromSession(this.deps.stateManager, chatSession);
    this.sessionCwd = resolveGitRoot(session.cwd);
    this.sessionActive = true;
    this.nativeAgentLoopStatePath = session.agentLoopStatePath ?? `chat/agentloop/${session.id}.state.json`;
    this.history.setAgentLoopStatePath(this.nativeAgentLoopStatePath);
    this.sessionExecutionPolicy = null;
  }

  getSessionId(): string | null {
    return this.history?.getSessionId() ?? null;
  }

  getCurrentSessionMessages(): ChatSession["messages"] {
    return this.history?.getMessages() ?? [];
  }

  hasActiveTurn(): boolean {
    return this.eventBridge.hasActiveTurn();
  }

  async interruptAndRedirect(input: string, cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ChatRunResult> {
    const activeTurn = this.eventBridge.getActiveTurn();
    if (!activeTurn) {
      return this.execute(input, cwd, timeoutMs);
    }

    const start = Date.now();
    const redirect = await classifyInterruptRedirect(input, {
      llmClient: this.deps.llmClient,
      cwd: activeTurn.cwd,
      activeTurnStartedAt: new Date(activeTurn.startedAt).toISOString(),
      recentEvents: activeTurn.recentEvents,
      sessionId: this.getSessionId(),
    });
    if (this.eventBridge.getActiveTurn() !== activeTurn) {
      return this.execute(input, cwd, timeoutMs);
    }
    if (redirect === "background") {
      return this.eventBridge.emitEphemeralAssistantResult(input, [
        "Continuing this same turn in the background is not available yet.",
        "",
        "The active turn is still running in the foreground.",
        "Use /tend for daemon-backed work, or send a narrower follow-up request.",
      ].join("\n"), true, start);
    }

    activeTurn.interruptRequested = true;
    if (!activeTurn.abortController.signal.aborted) {
      activeTurn.abortController.abort();
    }
    this.eventBridge.emitCheckpoint("Interrupt requested", `Redirect: ${previewActivityText(input, 120)}`, activeTurn.context, "interrupt");

    const stopped = await this.eventBridge.waitForActiveTurn(activeTurn, 2_000);
    if (!stopped) {
      return this.eventBridge.emitEphemeralAssistantResult(
        input,
        "Interrupt requested. The active turn will stop at the next safe point.",
        false,
        start
      );
    }

    let output: string;
    if (redirect === "diff") {
      const diff = await collectGitDiffArtifact(activeTurn.cwd);
      if (diff) {
        const context = this.eventBridge.createEventContext();
        this.eventBridge.emitDiffArtifact(diff, context);
        output = "Interrupted the active turn. Current diff is shown above.";
      } else {
        output = "Interrupted the active turn. No working-tree changes were detected.";
      }
    } else if (redirect === "review") {
      const review = await this.commandHandler.handleCommand("/review", activeTurn.cwd);
      output = `Interrupted the active turn and switched to review-only mode.\n\n${review?.output ?? "Review unavailable."}`;
    } else {
      output = [
        "Interrupted the active turn.",
        "",
        "Activity before interruption",
        ...(activeTurn.recentEvents.length > 0
          ? activeTurn.recentEvents.slice(-6).map((event) => `- ${event}`)
          : ["- No activity was captured before the interrupt."]),
        "",
        "Next actions",
        "- Ask for the exact continuation you want.",
        "- Ask to show diff or switch to review if files may have changed.",
      ].join("\n");
    }

    return this.eventBridge.emitEphemeralAssistantResult(input, output, true, start);
  }

  setRuntimeControlContext(context: RuntimeControlChatContext | null): void {
    this.runtimeControlContext = context;
  }

  async executeIngressMessage(
    ingress: ChatIngressMessage,
    cwd: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    selectedRoute: SelectedChatRoute
  ): Promise<ChatRunResult> {
    if (!selectedRoute) {
      throw new Error(
        "executeIngressMessage requires selectedRoute; use CrossPlatformChatSessionManager for ingress route selection."
      );
    }
    const runtimeControlContext = buildRuntimeControlContextFromIngress(ingress, this.runtimeControlContext, this.deps);
    return this.execute(ingress.text, cwd, timeoutMs, {
      selectedRoute,
      runtimeControlContext,
      goalId: ingress.goal_id,
    });
  }

  async execute(
    input: string,
    cwd: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    options: ChatRunnerExecutionOptions = {}
  ): Promise<ChatRunResult> {
    const eventContext = this.eventBridge.createEventContext();
    const resolvedCwd = resolveGitRoot(cwd);
    const activeTurn = this.eventBridge.beginActiveTurn(eventContext, resolvedCwd);
    const resumeCommand = this.commandHandler.parseResumeCommand(input);
    const resumeOnly = resumeCommand !== null;
    const setupSecretIntake = intakeSetupSecrets(input);
    this.setupSecretIntake = setupSecretIntake;
    const safeInput = setupSecretIntake.redactedText;
    this.turnLanguageHint = detectTurnLanguageHint(safeInput);
    eventContext.languageHint = this.turnLanguageHint;
    const persistedSecretIntake = setupSecretIntake.suppliedSecrets.map(({ value: _value, ...metadata }) => metadata);
    const runtimeControlContext = options.runtimeControlContext ?? this.runtimeControlContext;
    const executionGoalId = options.goalId ?? this.deps.goalId;

    const pendingTelegramSetupResult = await this.handlePendingSetupConfirmation(safeInput, runtimeControlContext);
    if (pendingTelegramSetupResult !== null) {
      return this.finalizeNonPersistentResult(pendingTelegramSetupResult, eventContext);
    }

    const pendingRunSpecConfirmationResult = await this.handlePendingRunSpecConfirmation(safeInput);
    if (pendingRunSpecConfirmationResult !== null) {
      return this.finalizeNonPersistentResult(pendingRunSpecConfirmationResult, eventContext);
    }

    const commandResult = resumeOnly ? null : await this.commandHandler.handleCommand(safeInput, resolvedCwd);
    if (commandResult !== null) {
      return this.finalizeNonPersistentResult(commandResult, eventContext);
    }

    if (this.pendingTend !== null && !resumeOnly) {
      const confirmationResult = await this.commandHandler.handleTendConfirmation(safeInput.trim(), Date.now());
      return this.finalizeNonPersistentResult(confirmationResult, eventContext);
    }

    if (resumeOnly && resumeCommand.selector) {
      try {
        const selectorResolution = await resolveChatResumeSelector(resumeCommand.selector, this.deps);
        if (selectorResolution.nonResumableMessage) {
          return this.finalizeNonPersistentResult({
            success: false,
            output: selectorResolution.nonResumableMessage,
            elapsed_ms: 0,
          }, eventContext);
        }
        const catalog = new ChatSessionCatalog(this.deps.stateManager);
        const session = await catalog.loadSessionBySelector(selectorResolution.chatSelector);
        if (!session) {
          return this.finalizeNonPersistentResult({
            success: false,
            output: `No chat session matched selector "${selectorResolution.chatSelector}".`,
            elapsed_ms: 0,
          }, eventContext);
        }
        this.startSessionFromLoadedSession(session);
      } catch (err) {
        const output = err instanceof ChatSessionSelectorError ? err.message : `Failed to load chat session: ${err instanceof Error ? err.message : String(err)}`;
        return this.finalizeNonPersistentResult({ success: false, output, elapsed_ms: 0 }, eventContext);
      }
    }

    if (!this.sessionActive) {
      const sessionId = crypto.randomUUID();
      this.history = new ChatHistory(this.deps.stateManager, sessionId, resolvedCwd);
      this.nativeAgentLoopStatePath = `chat/agentloop/${sessionId}.state.json`;
      this.history.resetAgentLoopState(this.nativeAgentLoopStatePath);
    }
    const executionCwd = this.sessionCwd ?? resolvedCwd;
    const gitRoot = this.sessionCwd ?? resolvedCwd;
    activeTurn.cwd = gitRoot;
    const history = this.history!;
    const pinnedReplyTarget = normalizePinnedReplyTarget(
      runtimeControlContext?.replyTarget ?? this.deps.runtimeReplyTarget ?? null,
    );
    if (pinnedReplyTarget) {
      history.setNotificationReplyTarget(pinnedReplyTarget);
    }

    this.eventBridge.emitEvent({
      type: "lifecycle_start",
      input: safeInput,
      ...this.eventBridge.eventBase(eventContext),
    });

    if (!resumeOnly) {
      await history.appendUserMessage(safeInput, { setupSecretIntake: persistedSecretIntake });
    }

    if (this.cachedStaticSystemPrompt === null) {
      try {
        this.cachedStaticSystemPrompt = buildStaticSystemPrompt(this.providerConfigBaseDir());
      } catch {
        this.cachedStaticSystemPrompt = "";
      }
    }

    const messages = history.getMessages();
    const compactionSummary = history.getSessionData().compactionSummary;
    const priorTurns = resumeOnly ? messages.slice(-10) : messages.slice(0, -1).slice(-10);
    const historySections: string[] = [];
    if (compactionSummary) {
      historySections.push(`Compacted previous conversation summary:\n${compactionSummary}`);
    }
    if (priorTurns.length > 0) {
      const lines = priorTurns.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n");
      historySections.push(`Previous conversation:\n${lines}`);
    }
    const historyBlock = historySections.length > 0 ? `${historySections.join("\n\n")}\n\nCurrent message:\n` : "";

    const selectedRoute = resumeOnly
      ? null
      : (options.selectedRoute ?? await this.resolveRouteFromInput(safeInput, runtimeControlContext, resolvedCwd));
    this.lastSelectedRoute = selectedRoute;
    if (selectedRoute?.kind !== "configure") {
      this.eventBridge.emitIntent(safeInput, selectedRoute, eventContext);
    }

    const start = Date.now();
    const assistantBuffer: AssistantBuffer = { text: "" };
    const identityResponse = resumeOnly ? null : resolveSelfIdentityResponse(safeInput, this.providerConfigBaseDir());

    if (identityResponse !== null) {
      const elapsed_ms = Date.now() - start;
      await history.appendAssistantMessage(identityResponse);
      this.eventBridge.emitActivity("lifecycle", "Finalizing response...", eventContext, "lifecycle:finalizing");
      this.eventBridge.emitEvent({
        type: "assistant_final",
        text: identityResponse,
        persisted: true,
        ...this.eventBridge.eventBase(eventContext),
      });
      this.eventBridge.emitLifecycleEndEvent("completed", elapsed_ms, eventContext, true);
      return {
        success: true,
        output: identityResponse,
        elapsed_ms,
      };
    }

    if (selectedRoute?.kind === "runtime_control") {
      this.eventBridge.emitCheckpoint("Runtime control selected", `${selectedRoute.intent.kind} request recognized.`, eventContext, "route");
      const runtimeControlResult = await executeRuntimeControlRoute(this.routeHost(), selectedRoute, runtimeControlContext, executionCwd, start);
      if (runtimeControlResult.success) {
        await history.appendAssistantMessage(runtimeControlResult.output);
        this.eventBridge.emitCheckpoint("Runtime control completed", "The runtime-control operation produced a result.", eventContext, "complete");
        this.eventBridge.emitActivity("lifecycle", "Finalizing response...", eventContext, "lifecycle:finalizing");
        this.eventBridge.emitEvent({
          type: "assistant_final",
          text: runtimeControlResult.output,
          persisted: true,
          ...this.eventBridge.eventBase(eventContext),
        });
        this.eventBridge.emitLifecycleEndEvent("completed", runtimeControlResult.elapsed_ms, eventContext, true);
      } else {
        runtimeControlResult.output = await this.eventBridge.emitLifecycleErrorEventWithFallback(
          runtimeControlResult.output,
          assistantBuffer.text,
          eventContext,
          {
            signals: [{
              kind: "runtime",
              operationState: "runtime_control",
              stoppedReason: "runtime_control_failed",
            }],
          },
          this.deps.llmClient
        );
        this.eventBridge.emitLifecycleEndEvent("error", runtimeControlResult.elapsed_ms, eventContext, false);
      }
      return runtimeControlResult;
    }

    if (selectedRoute?.kind === "runtime_control_blocked") {
      const output = formatBlockedRuntimeControlRoute(selectedRoute);
      this.eventBridge.pushAssistantDelta(output, assistantBuffer, eventContext);
      await history.appendAssistantMessage(output);
      this.eventBridge.emitEvent({
        type: "assistant_final",
        text: output,
        persisted: true,
        ...this.eventBridge.eventBase(eventContext),
      });
      const elapsed_ms = Date.now() - start;
      this.eventBridge.emitLifecycleEndEvent("error", elapsed_ms, eventContext, true);
      return {
        success: false,
        output,
        elapsed_ms,
      };
    }

    if (selectedRoute?.kind === "run_spec_draft") {
      const result = await executeRunSpecDraftRoute(this.routeHost(), selectedRoute, eventContext, assistantBuffer, history, start);
      return result;
    }

    if (selectedRoute?.kind === "configure") {
      const result = await executeConfigureRoute(this.routeHost(), selectedRoute, eventContext, assistantBuffer, history, start);
      return result;
    }

    if (selectedRoute?.kind === "clarify") {
      const result = await executeClarifyRoute(this.routeHost(), selectedRoute, eventContext, assistantBuffer, history, start);
      return result;
    }

    if (selectedRoute?.kind === "assist") {
      const result = await executeAssistRoute(this.routeHost(), {
        input: safeInput,
        priorTurns,
        eventContext,
        assistantBuffer,
        history,
        start,
      });
      return result;
    }

    const usesNativeAgentLoop = resumeOnly || selectedRoute?.kind === "agent_loop";
    const groundingWorkspaceContext = !resumeOnly && usesNativeAgentLoop
      ? await buildChatContext(safeInput, executionCwd)
      : undefined;

    let systemPrompt = this.cachedStaticSystemPrompt ?? "";
    if (!resumeOnly) {
      try {
        this.eventBridge.emitActivity("lifecycle", "Preparing context...", eventContext, "lifecycle:context");
        if (usesNativeAgentLoop) {
          systemPrompt = await buildChatAgentLoopSystemPrompt({
            stateManager: this.deps.stateManager,
            pluginLoader: this.deps.pluginLoader,
            workspaceRoot: executionCwd,
            goalId: executionGoalId,
            userMessage: safeInput,
            trustProjectInstructions: this.sessionExecutionPolicy?.trustProjectInstructions ?? true,
            workspaceContext: groundingWorkspaceContext,
          });
        } else {
          const groundingBundle = await this.groundingGateway.build({
            surface: "chat",
            purpose: "general_turn",
            workspaceRoot: executionCwd,
            goalId: executionGoalId,
            userMessage: safeInput,
            query: safeInput,
            trustProjectInstructions: this.sessionExecutionPolicy?.trustProjectInstructions ?? true,
          });
          systemPrompt = String(groundingBundle.render("prompt"));
        }
      } catch {
        systemPrompt = this.cachedStaticSystemPrompt ?? "";
      }
      this.eventBridge.emitCheckpoint("Context gathered", usesNativeAgentLoop
        ? "Workspace and agent-loop grounding are ready."
        : "Workspace grounding is ready.", eventContext, "context");
    }
    const agentLoopSystemPrompt = [
      systemPrompt,
      sameLanguageResponseInstruction(this.turnLanguageHint),
      compactionSummary ? `## Compacted Chat Summary\n${compactionSummary}` : "",
    ]
      .filter((section) => section && section.trim().length > 0)
      .join("\n\n")
      .trim();

    const context = resumeOnly || usesNativeAgentLoop ? "" : await buildChatContext(safeInput, gitRoot);
    const basePrompt = resumeOnly ? "" : (context ? `${context}\n\n${safeInput}` : safeInput);
    const prompt = historyBlock ? `${historyBlock}${basePrompt}` : basePrompt;

    if (resumeOnly && !this.deps.chatAgentLoopRunner) {
      const elapsed_ms = Date.now() - start;
      const output = await this.eventBridge.emitLifecycleErrorEventWithFallback(
        "Resume requires the native chat agentloop runtime.",
        assistantBuffer.text,
        eventContext,
        {
          code: "resume_state_missing",
          stoppedReason: "resume_state_missing",
        },
        this.deps.llmClient
      );
      this.eventBridge.emitLifecycleEndEvent("error", elapsed_ms, eventContext, false);
      return { success: false, output, elapsed_ms };
    }

    if (resumeOnly || selectedRoute?.kind === "agent_loop") {
      return executeAgentLoopRoute(this.routeHost(), {
        resumeOnly,
        executionCwd,
        executionGoalId,
        basePrompt,
        priorTurns,
        agentLoopSystemPrompt,
        assistantBuffer,
        eventContext,
        history,
        gitRoot,
        activeAbortSignal: activeTurn.abortController.signal,
        start,
      });
    }

    if (selectedRoute?.kind === "tool_loop") {
      return executeToolLoopRoute(this.routeHost(), {
        prompt,
        eventContext,
        assistantBuffer,
        systemPrompt: systemPrompt || undefined,
        executionGoalId,
        history,
        gitRoot,
        start,
      });
    }

    if (!resumeOnly && selectedRoute && selectedRoute.kind !== "adapter") {
      const elapsed_ms = Date.now() - start;
      const output = await this.eventBridge.emitLifecycleErrorEventWithFallback(
        `Unsupported chat route: ${selectedRoute.kind}`,
        assistantBuffer.text,
        eventContext,
        {},
        this.deps.llmClient
      );
      this.eventBridge.emitLifecycleEndEvent("error", elapsed_ms, eventContext, false);
      return { success: false, output, elapsed_ms };
    }

    return executeAdapterRoute(this.routeHost(), {
      prompt,
      cwd,
      timeoutMs,
      systemPrompt: systemPrompt || undefined,
      eventContext,
      assistantBuffer,
      gitRoot,
      start,
      history,
    });
  }

  getSessionCwd(): string | null {
    return this.sessionCwd;
  }

  getNativeAgentLoopStatePath(): string | null {
    return this.nativeAgentLoopStatePath;
  }

  setSessionExecutionPolicy(policy: ExecutionPolicy): void {
    this.sessionExecutionPolicy = policy;
  }

  async getSessionExecutionPolicy(): Promise<ExecutionPolicy> {
    const policy = await resolveSessionExecutionPolicy(this.sessionExecutionPolicy, this.sessionCwd);
    this.sessionExecutionPolicy = policy;
    return policy;
  }

  private async resolveRouteFromIngress(ingress: ChatIngressMessage): Promise<SelectedChatRoute> {
    const capabilities = getRouteCapabilities(this.deps);
    const shouldPreferFreeformBeforeDeniedRuntimeControl =
      ingress.metadata["runtime_control_denied"] === true
      && ingress.metadata["runtime_control_approved"] !== true
      && ingress.metadata["runtime_control_explicit"] !== true
      && capabilities.hasAgentLoop;
    let freeformRouteIntent = shouldPreferFreeformBeforeDeniedRuntimeControl
      ? await classifyFreeformRouteIntent(ingress.text, this.deps.llmClient)
      : null;
    const shouldClassifyRuntimeControl =
      (capabilities.hasRuntimeControlService && ingress.runtimeControl.approvalMode !== "disallowed")
      || ingress.metadata["runtime_control_approved"] === true
      || ingress.metadata["runtime_control_denied"] === true
      || ingress.metadata["runtime_control_explicit"] === true;
    const runtimeControlIntent = freeformRouteIntent === null && shouldClassifyRuntimeControl
      ? await recognizeRuntimeControlIntent(ingress.text, this.deps.llmClient)
      : null;
    if (freeformRouteIntent === null && runtimeControlIntent === null && capabilities.hasAgentLoop) {
      freeformRouteIntent = await classifyFreeformRouteIntent(ingress.text, this.deps.llmClient);
    }
    const shouldDeriveRunSpecDraft =
      runtimeControlIntent === null
      && freeformRouteIntent?.kind === "run_spec"
      && freeformRouteIntent.confidence >= 0.7;
    const runSpecDraft = shouldDeriveRunSpecDraft
      ? await deriveRunSpecFromText(ingress.text, {
        cwd: ingress.cwd ?? this.sessionCwd ?? undefined,
        conversationId: ingress.conversation_id ?? null,
        channel: ingress.channel,
        sessionId: this.history?.getSessionId() ?? ingress.conversation_id ?? null,
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
    return standaloneIngressRouter.selectRoute(ingress, {
      ...capabilities,
      runtimeControlIntent,
      freeformRouteIntent,
      setupSecretIntake: this.setupSecretIntake,
      runSpecDraft,
    });
  }

  private async resolveRouteFromInput(
    input: string,
    runtimeControlContext: RuntimeControlChatContext | null,
    cwd?: string
  ): Promise<SelectedChatRoute> {
    const ingress = buildStandaloneIngressMessageFromContext(input, runtimeControlContext, this.deps);
    return this.resolveRouteFromIngress(cwd ? { ...ingress, cwd } : ingress);
  }

  private loadedSessionToChatSession(session: LoadedChatSession): ChatSession {
    return loadedSessionToChatSession(session);
  }

  private routeHost() {
    return {
      deps: this.deps,
      eventBridge: this.eventBridge,
      activatedTools: this.activatedTools,
      getConversationSessionId: () => this.history?.getSessionId() ?? null,
      getSessionCwd: () => this.sessionCwd,
      getNativeAgentLoopStatePath: () => this.nativeAgentLoopStatePath,
      getProviderConfigBaseDir: () => this.providerConfigBaseDir(),
      getSetupSecretIntake: () => this.setupSecretIntake,
      getTurnLanguageHint: () => this.turnLanguageHint,
      setPendingSetupDialogue: async (dialogue: SetupDialogueRuntimeState) => {
        this.pendingSetupDialogue = dialogue;
        this.history?.setSetupDialogue(dialogue.publicState);
        await this.history?.persist();
      },
      setPendingRunSpecConfirmation: async (confirmation: NonNullable<ReturnType<ChatHistory["getRunSpecConfirmation"]>>) => {
        this.history?.setRunSpecConfirmation(confirmation);
        await this.history?.persist();
      },
      getSessionExecutionPolicy: () => this.getSessionExecutionPolicy(),
      setSessionExecutionPolicy: (policy: ExecutionPolicy) => { this.sessionExecutionPolicy = policy; },
    };
  }

  private providerConfigBaseDir(): string {
    const stateManager = this.deps.stateManager as StateManager & { getBaseDir?: () => string };
    return typeof stateManager.getBaseDir === "function" ? stateManager.getBaseDir() : getPulseedDirPath();
  }

  private async handlePendingRunSpecConfirmation(input: string): Promise<ChatRunResult | null> {
    const pending = this.history?.getRunSpecConfirmation() ?? null;
    if (!pending || pending.state !== "pending") return null;
    const start = Date.now();
    const result = await handleRunSpecConfirmationInput(pending.spec, input, {
      llmClient: this.deps.llmClient,
    });
    const store = createRunSpecStore(this.deps.stateManager);
    await store.save(result.spec);

    if (result.kind === "confirmed") {
      const safetyBlock = validateRunSpecStartSafety(result.spec);
      if (safetyBlock) {
        const pendingSpec: RunSpec = {
          ...result.spec,
          status: "draft",
        };
        await store.save(pendingSpec);
        this.history?.setRunSpecConfirmation({
          ...pending,
          state: "pending",
          spec: pendingSpec,
          updatedAt: pendingSpec.updated_at,
        });
        await this.history?.persist();
        return {
          success: false,
          output: safetyBlock,
          elapsed_ms: Date.now() - start,
        };
      }
      const started = await this.startConfirmedRunSpec(result.spec);
      this.history?.setRunSpecConfirmation({
        ...pending,
        state: "confirmed",
        spec: result.spec,
        updatedAt: result.spec.updated_at,
      });
      await this.history?.persist();
      return { ...started, elapsed_ms: Date.now() - start };
    }

    if (result.kind === "cancelled") {
      this.history?.setRunSpecConfirmation(null);
      await this.history?.persist();
      return {
        success: false,
        output: `${result.message}\nNo background run was started.`,
        elapsed_ms: Date.now() - start,
      };
    }

    if (result.kind === "revised") {
      const proposal = formatRunSpecSetupProposal(result.spec);
      this.history?.setRunSpecConfirmation({
        ...pending,
        spec: result.spec,
        prompt: proposal,
        updatedAt: result.spec.updated_at,
      });
      await this.history?.persist();
      return {
        success: true,
        output: [
          proposal,
          "",
          "RunSpec updated. Reply with approval to confirm, cancel to discard it, or provide another update.",
        ].join("\n"),
        elapsed_ms: Date.now() - start,
      };
    }

    if (result.kind === "blocked") {
      this.history?.setRunSpecConfirmation({
        ...pending,
        spec: result.spec,
        updatedAt: result.spec.updated_at,
      });
      await this.history?.persist();
      return {
        success: false,
        output: result.message,
        elapsed_ms: Date.now() - start,
      };
    }

    return {
      success: false,
      output: result.message,
      elapsed_ms: Date.now() - start,
    };
  }

  private async startConfirmedRunSpec(spec: RunSpec): Promise<ChatRunResult> {
    const start = Date.now();
    const safetyBlock = validateRunSpecStartSafety(spec);
    if (safetyBlock) {
      return {
        success: false,
        output: safetyBlock,
        elapsed_ms: Date.now() - start,
      };
    }
    if (!this.deps.daemonClient) {
      return {
        success: false,
        output: [
          `RunSpec confirmed: ${spec.id}`,
          "",
          "Daemon start is unavailable in this chat surface, so no background run was started.",
          "Start or connect the PulSeed daemon, then approve from a daemon-capable chat surface.",
        ].join("\n"),
        elapsed_ms: Date.now() - start,
      };
    }

    const goal = await this.createGoalFromRunSpec(spec);
    const run = await this.createRunSpecBackgroundRun(spec, goal);
    try {
      await this.deps.daemonClient.startGoal(goal.id, {
        backgroundRun: {
          backgroundRunId: run.id,
          parentSessionId: run.parent_session_id,
          notifyPolicy: run.notify_policy,
          replyTargetSource: run.reply_target_source,
          pinnedReplyTarget: run.pinned_reply_target,
        },
      });
      return {
        success: true,
        output: [
          `RunSpec confirmed: ${spec.id}`,
          `Started daemon-backed CoreLoop goal: ${goal.id}`,
          `Background run: ${run.id}`,
          "Run `pulseed status` or `/sessions` to check progress.",
        ].join("\n"),
        elapsed_ms: Date.now() - start,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await Promise.all(this.getBackgroundRunLedgers().map((ledger) => ledger.terminal(run.id, {
        status: "failed",
        completed_at: new Date().toISOString(),
        error: message,
      }).catch(() => undefined)));
      return {
        success: false,
        output: [
          `RunSpec confirmed: ${spec.id}`,
          "",
          `Daemon start failed, so no CoreLoop run was started: ${message}`,
          "Start the daemon with `pulseed daemon start`, then approve the RunSpec again from a daemon-capable chat surface.",
          `Background run record marked failed: ${run.id}`,
        ].join("\n"),
        elapsed_ms: Date.now() - start,
      };
    }
  }

  private async createGoalFromRunSpec(spec: RunSpec): Promise<Goal> {
    if (spec.links.goal_id) {
      const existing = await this.deps.stateManager.loadGoal(spec.links.goal_id);
      if (existing) return existing;
    }
    const now = new Date().toISOString();
    const goal = GoalSchema.parse({
      id: `goal-runspec-${randomUUID()}`,
      parent_id: null,
      node_type: "goal",
      title: spec.objective,
      description: [
        spec.objective,
        "",
        `Source RunSpec: ${spec.id}`,
        `Original request: ${spec.source_text}`,
      ].join("\n"),
      status: "active",
      dimensions: [goalDimensionFromRunSpec(spec, now)],
      gap_aggregation: "max",
      dimension_mapping: null,
      constraints: goalConstraintsFromRunSpec(spec),
      children_ids: [],
      target_date: spec.deadline?.iso_at ?? null,
      origin: "manual",
      pace_snapshot: null,
      deadline: spec.deadline?.iso_at ?? null,
      confidence_flag: spec.confidence,
      user_override: false,
      feasibility_note: `Derived from natural-language RunSpec ${spec.id}`,
      uncertainty_weight: 1,
      created_at: now,
      updated_at: now,
    });
    await this.deps.stateManager.saveGoal(goal);
    const updatedSpec = {
      ...spec,
      links: {
        ...spec.links,
        goal_id: goal.id,
      },
      updated_at: now,
    };
    await createRunSpecStore(this.deps.stateManager).save(updatedSpec);
    return goal;
  }

  private async createRunSpecBackgroundRun(spec: RunSpec, goal: Goal) {
    const sessionId = this.history?.getSessionId() ?? spec.origin.session_id;
    const pinnedReplyTarget = normalizePinnedReplyTargetForRunSpec(
      this.runtimeControlContext?.replyTarget
      ?? this.deps.runtimeReplyTarget
      ?? (spec.origin.reply_target as RuntimeControlReplyTarget | null)
      ?? null,
    );
    const input: BackgroundRunCreateInput = {
      id: `run:coreloop:${randomUUID()}`,
      kind: "coreloop_run",
      goal_id: goal.id,
      parent_session_id: sessionId ? `session:conversation:${sessionId}` : null,
      notify_policy: pinnedReplyTarget ? "done_only" : "silent",
      reply_target_source: pinnedReplyTarget ? "pinned_run" : "none",
      pinned_reply_target: pinnedReplyTarget,
      title: goal.title,
      workspace: spec.workspace?.path ?? this.sessionCwd ?? null,
      source_refs: [
        ...(sessionId ? [{
          kind: "chat_session" as const,
          id: sessionId,
          path: null,
          relative_path: `chat/sessions/${sessionId}.json`,
          updated_at: null,
        }] : []),
        {
          kind: "artifact",
          id: spec.id,
          path: null,
          relative_path: `run-specs/${spec.id}.json`,
          updated_at: spec.updated_at,
        },
      ],
      origin_metadata: {
        run_spec_id: spec.id,
        run_spec_origin: spec.origin,
        source_text: spec.source_text,
      },
    };
    const [primary, ...mirrors] = this.getBackgroundRunLedgers();
    const run = await primary.create(input);
    await Promise.all(mirrors.map((ledger) => ledger.create(input).catch(() => undefined)));
    return run;
  }

  private getBackgroundRunLedgers(): BackgroundRunLedger[] {
    const baseRuntimeRoot = `${this.deps.stateManager.getBaseDir()}/runtime`;
    const configuredRuntimeRoot = resolveConfiguredDaemonRuntimeRoot(this.deps.stateManager.getBaseDir());
    const roots = [...new Set([configuredRuntimeRoot, baseRuntimeRoot])];
    return roots.map((root) => new BackgroundRunLedger(root));
  }

  private async handlePendingSetupConfirmation(
    input: string,
    runtimeControlContext: RuntimeControlChatContext | null
  ): Promise<ChatRunResult | null> {
    const commandConfirmed = isSetupWriteConfirmCommand(input);
    const pendingAtInput = this.pendingSetupDialogue;
    if (!commandConfirmed) {
      if (!pendingAtInput || pendingAtInput.publicState.state !== "confirm_write") return null;
      const decision = await classifyConfirmationDecision(input, {
        llmClient: this.deps.llmClient,
        kind: "approval",
        subject: formatPendingSetupConfirmationSubject(pendingAtInput.publicState),
        allowedDecisions: ["approve", "cancel", "unknown"],
      });
      if (decision.decision === "cancel") {
        this.pendingSetupDialogue = null;
        this.history?.setSetupDialogue(null);
        await this.history?.persist();
        return {
          success: false,
          output: formatSetupConfirmationCancelled(this.turnLanguageHint),
          elapsed_ms: 0,
        };
      }
      if (decision.decision !== "approve") return null;
    }
    const pending = this.pendingSetupDialogue;
    if (!pending) {
      return {
        success: false,
        output: "No pending setup write is available. Paste the secret again to start a protected setup turn.",
        elapsed_ms: 0,
      };
    }
    if (pending.publicState.selectedChannel !== "telegram" || pending.publicState.action?.kind !== "write_gateway_config") {
      return {
        success: false,
        output: `The pending setup dialogue is for ${pending.publicState.selectedChannel}, so it cannot be confirmed as a Telegram config write. Start a new Telegram setup turn with a Telegram bot token.`,
        elapsed_ms: 0,
      };
    }
    if (!pending.secretValue) {
      return {
        success: false,
        output: "The pending setup dialogue no longer has a transient secret value. Paste the token again so PulSeed can keep it protected through a fresh confirmation.",
        elapsed_ms: 0,
      };
    }
    const approvalFn = runtimeControlContext
      ? runtimeControlContext.approvalFn
      : this.deps.runtimeControlApprovalFn ?? this.deps.approvalFn;
    if (!approvalFn) {
      return {
        success: false,
        output: "Telegram setup requires an approval-capable chat surface before writing config. Use `pulseed telegram setup` instead.",
        elapsed_ms: 0,
      };
    }
    const baseDir = this.providerConfigBaseDir();
    const configDir = getGatewayChannelDir("telegram-bot", baseDir);
    const configPath = `${configDir}/config.json`;
    const current = await readJsonFileOrNull<Partial<TelegramGatewayConfig>>(configPath);
    const nextAllowAll = typeof current?.allow_all === "boolean" ? current.allow_all : false;
    const nextAllowedUserIds = Array.isArray(current?.allowed_user_ids) ? current.allowed_user_ids : [];
    const nextRuntimeControlAllowedUserIds = Array.isArray(current?.runtime_control_allowed_user_ids)
      ? current.runtime_control_allowed_user_ids
      : [];
    const accessClosedByDefault = !nextAllowAll && nextAllowedUserIds.length === 0 && nextRuntimeControlAllowedUserIds.length === 0;
    const approved = await approvalFn([
      "Write Telegram gateway config from the redacted chat-supplied bot token.",
      pending.publicState.replacesExistingSecret
        ? "This will replace the existing configured Telegram bot token."
        : "",
      accessClosedByDefault
        ? "Access will remain closed by default with allow_all=false until allowed Telegram user IDs are configured."
        : "Existing Telegram access policy will be preserved.",
    ].filter(Boolean).join(" "));
    if (!approved) {
      this.pendingSetupDialogue = null;
      this.history?.setSetupDialogue(null);
      await this.history?.persist();
      return {
        success: false,
        output: "Telegram setup was not changed because approval was denied.",
        elapsed_ms: 0,
      };
    }
    const nextConfig: TelegramGatewayConfig = {
      bot_token: pending.secretValue,
      ...(typeof current?.chat_id === "number" ? { chat_id: current.chat_id } : {}),
      allowed_user_ids: nextAllowedUserIds,
      denied_user_ids: Array.isArray(current?.denied_user_ids) ? current.denied_user_ids : [],
      allowed_chat_ids: Array.isArray(current?.allowed_chat_ids) ? current.allowed_chat_ids : [],
      denied_chat_ids: Array.isArray(current?.denied_chat_ids) ? current.denied_chat_ids : [],
      runtime_control_allowed_user_ids: nextRuntimeControlAllowedUserIds,
      chat_goal_map: current?.chat_goal_map ?? {},
      user_goal_map: current?.user_goal_map ?? {},
      ...(current?.default_goal_id ? { default_goal_id: current.default_goal_id } : {}),
      allow_all: nextAllowAll,
      polling_timeout: current?.polling_timeout ?? 30,
      ...(current?.identity_key ? { identity_key: current.identity_key } : {}),
    };
    await writeJsonFileAtomic(configPath, nextConfig);
    const refreshResult = await this.requestTelegramGatewayRefreshAfterSetup(runtimeControlContext, approvalFn, baseDir);
    this.pendingSetupDialogue = {
      publicState: {
        ...pending.publicState,
        state: refreshResult.success ? "verify" : "restart_offer",
        updatedAt: new Date().toISOString(),
        action: pending.publicState.action
          ? { ...pending.publicState.action, status: "completed" }
          : pending.publicState.action,
      },
    };
    this.history?.setSetupDialogue(this.pendingSetupDialogue.publicState);
    await this.history?.persist();
    return {
      success: true,
      output: [
        this.turnLanguageHint.language === "ja"
          ? "redacted chat-supplied token から Telegram gateway config を書き込みました。"
          : "Telegram gateway config was written from the redacted chat-supplied token.",
        "",
        formatTelegramSetupRefreshResult(refreshResult, this.turnLanguageHint),
        "",
        this.turnLanguageHint.language === "ja" ? "Next steps:" : "Next steps:",
        ...(accessClosedByDefault
          ? [this.turnLanguageHint.language === "ja"
            ? "- allowed Telegram user IDs を設定するか、`pulseed telegram setup` で意図的に `allow_all` を有効にするまで access は closed のままです。"
            : "- Access remains closed until you configure allowed Telegram user IDs or intentionally enable `allow_all` with `pulseed telegram setup`."]
          : []),
        this.turnLanguageHint.language === "ja"
          ? "- home chat が未設定なら Telegram から `/sethome` を送ってください。"
          : "- Send `/sethome` from Telegram if no home chat is configured yet.",
        refreshResult.success
          ? this.turnLanguageHint.language === "ja"
            ? "- Telegram bot にメッセージを送って動作確認してください。"
            : "- Send a message to the Telegram bot to verify delivery."
          : this.turnLanguageHint.language === "ja"
            ? "- 自動反映できませんでした。daemon lifecycle 操作は typed runtime-control が利用可能な chat surface から再実行してください。"
            : "- Automatic refresh was not applied. Retry the lifecycle refresh from a chat surface with typed runtime-control available.",
      ].join("\n"),
      elapsed_ms: 0,
    };
  }

  private async requestTelegramGatewayRefreshAfterSetup(
    runtimeControlContext: RuntimeControlChatContext | null,
    approvalFn: ((description: string) => Promise<boolean>) | undefined,
    baseDir: string
  ): Promise<{ success: boolean; message: string; operationId?: string; state?: string; unavailable?: boolean }> {
    if (!this.deps.runtimeControlService) {
      return {
        success: false,
        unavailable: true,
        message: "Runtime control service is not available in this chat surface.",
      };
    }
    const result = await this.deps.runtimeControlService.request({
      intent: {
        kind: "restart_gateway",
        reason: "Apply updated Telegram gateway config after approved setup write.",
      },
      cwd: baseDir,
      ...(runtimeControlContext?.actor ? { requestedBy: runtimeControlContext.actor } : {}),
      ...(runtimeControlContext?.replyTarget ? { replyTarget: runtimeControlContext.replyTarget } : {}),
      ...(approvalFn ? { approvalFn } : {}),
    });
    return {
      success: result.success,
      message: result.message,
      ...(result.operationId ? { operationId: result.operationId } : {}),
      ...(result.state ? { state: result.state } : {}),
    };
  }

  private finalizeNonPersistentResult(result: ChatRunResult, eventContext: Parameters<ChatRunnerEventBridge["eventBase"]>[0]): ChatRunResult {
    if (result.output) {
      this.eventBridge.emitEvent({
        type: "assistant_final",
        text: result.output,
        persisted: false,
        ...this.eventBridge.eventBase(eventContext),
      });
    }
    this.eventBridge.emitLifecycleEndEvent(result.success ? "completed" : "error", result.elapsed_ms, eventContext, false);
    return result;
  }
}

void COMMAND_HELP;
void formatRoute;
