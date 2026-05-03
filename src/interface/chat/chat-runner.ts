// ─── ChatRunner ───
//
// Central coordinator for 1-shot chat execution (Tier 1).
// Bypasses TaskLifecycle — calls adapter.execute() directly.

import type { StateManager } from "../../base/state/state-manager.js";
import type { IAdapter } from "../../orchestrator/execution/adapter-layer.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import { getPulseedDirPath } from "../../base/utils/paths.js";
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
import type { GoalNegotiator } from "../../orchestrator/goal/goal-negotiator.js";
import type { ChatEvent } from "./chat-events.js";
import type { ChatAgentLoopRunner } from "../../orchestrator/execution/agent-loop/chat-agent-loop-runner.js";
import type { ReviewAgentLoopRunner } from "../../orchestrator/execution/agent-loop/review-agent-loop-runner.js";
import type { RuntimeControlService } from "../../runtime/control/index.js";
import { recognizeRuntimeControlIntent } from "../../runtime/control/index.js";
import type {
  RuntimeControlActor,
  RuntimeControlReplyTarget,
} from "../../runtime/store/runtime-operation-schemas.js";
import type { RuntimeReplyTarget } from "../../runtime/session-registry/types.js";
import type { ExecutionPolicy } from "../../orchestrator/execution/agent-loop/execution-policy.js";
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
  executeAgentLoopRoute,
  executeRuntimeControlRoute,
  executeToolLoopRoute,
  resolveSessionExecutionPolicy,
} from "./chat-runner-routes.js";
import { classifyFreeformRouteIntent } from "./freeform-route-classifier.js";

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
  onEvent?: (event: ChatEvent) => void;
  chatAgentLoopRunner?: ChatAgentLoopRunner;
  reviewAgentLoopRunner?: Pick<ReviewAgentLoopRunner, "execute">;
  runtimeControlService?: Pick<RuntimeControlService, "request">;
  runtimeControlApprovalFn?: (description: string) => Promise<boolean>;
  runtimeReplyTarget?: RuntimeControlReplyTarget;
  runtimeControlActor?: RuntimeControlActor;
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
  onEvent: ((event: ChatEvent) => void) | undefined = undefined;
  private nativeAgentLoopStatePath: string | null = null;
  private runtimeControlContext: RuntimeControlChatContext | null = null;
  private sessionExecutionPolicy: ExecutionPolicy | null = null;
  private lastSelectedRoute: SelectedChatRoute | null = null;
  private setupSecretIntake: ReturnType<typeof intakeSetupSecrets> | null = null;

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
    const persistedSecretIntake = setupSecretIntake.suppliedSecrets.map(({ value: _value, ...metadata }) => metadata);
    const runtimeControlContext = options.runtimeControlContext ?? this.runtimeControlContext;
    const executionGoalId = options.goalId ?? this.deps.goalId;

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
      : (options.selectedRoute ?? await this.resolveRouteFromInput(safeInput, runtimeControlContext));
    this.lastSelectedRoute = selectedRoute;
    this.eventBridge.emitIntent(safeInput, selectedRoute, eventContext);

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
    const runtimeControlAllowed =
      ingress.runtimeControl.allowed
      && ingress.runtimeControl.approvalMode !== "disallowed"
      && (
        capabilities.hasRuntimeControlService
        || (!capabilities.hasAgentLoop && !capabilities.hasToolLoop)
      );
    const runtimeControlIntent = runtimeControlAllowed
      ? await recognizeRuntimeControlIntent(ingress.text, this.deps.llmClient)
      : null;
    const freeformRouteIntent = runtimeControlIntent === null && capabilities.hasAgentLoop
      ? await classifyFreeformRouteIntent(ingress.text, this.deps.llmClient)
      : null;
    return standaloneIngressRouter.selectRoute(ingress, {
      ...capabilities,
      runtimeControlIntent,
      freeformRouteIntent,
      setupSecretIntake: this.setupSecretIntake,
    });
  }

  private async resolveRouteFromInput(
    input: string,
    runtimeControlContext: RuntimeControlChatContext | null
  ): Promise<SelectedChatRoute> {
    return this.resolveRouteFromIngress(
      buildStandaloneIngressMessageFromContext(input, runtimeControlContext, this.deps)
    );
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
      getSetupSecretIntake: () => this.setupSecretIntake,
      getSessionExecutionPolicy: () => this.getSessionExecutionPolicy(),
      setSessionExecutionPolicy: (policy: ExecutionPolicy) => { this.sessionExecutionPolicy = policy; },
    };
  }

  private providerConfigBaseDir(): string {
    const stateManager = this.deps.stateManager as StateManager & { getBaseDir?: () => string };
    return typeof stateManager.getBaseDir === "function" ? stateManager.getBaseDir() : getPulseedDirPath();
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
