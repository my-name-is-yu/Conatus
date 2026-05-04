import type { IAdapter, AgentTask } from "../../orchestrator/execution/adapter-layer.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse, ToolCallResult } from "../../base/llm/llm-client.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import type { ToolCallContext } from "../../tools/types.js";
import { toToolDefinitionsFiltered } from "../../tools/tool-definition-adapter.js";
import {
  buildPromptedToolProtocolSystemPrompt,
  extractPromptedToolCalls,
} from "../../orchestrator/execution/agent-loop/prompted-tool-protocol.js";
import { verifyChatAction } from "./chat-verifier.js";
import {
  collectGitDiffArtifact,
  formatToolActivity,
} from "./chat-runner-support.js";
import type { ChatUsageCounter } from "./chat-history.js";
import type { ChatRunResult, ChatRunnerDeps, RuntimeControlChatContext } from "./chat-runner.js";
import type { SelectedChatRoute } from "./ingress-router.js";
import type { ChatEventContext } from "./chat-events.js";
import type { AgentLoopSessionState } from "../../orchestrator/execution/agent-loop/agent-loop-session-state.js";
import { resolveExecutionPolicy, type ExecutionPolicy } from "../../orchestrator/execution/agent-loop/execution-policy.js";
import type { AssistantBuffer, ChatRunnerEventBridge } from "./chat-runner-event-bridge.js";
import type { SetupSecretIntakeResult } from "./setup-secret-intake.js";
import { createGatewaySetupStatusProvider, type TelegramSetupStatus } from "./gateway-setup-status.js";
import {
  createDiscordAdapterPlanDialogue,
  createTelegramConfirmWriteDialogue,
  SETUP_WRITE_CONFIRM_COMMAND,
  type SetupDialogueRuntimeState,
} from "./setup-dialogue.js";
import {
  sameLanguageResponseInstruction,
  shouldRenderJapanese,
  type TurnLanguageHint,
} from "./turn-language.js";
import { createOperationProgressItem } from "./operation-progress.js";
import { createRunSpecStore, formatRunSpecSetupProposal } from "../../runtime/run-spec/index.js";
import type { RunSpecConfirmationState } from "./chat-history.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_VERIFY_RETRIES = 2;
const MAX_TOOL_LOOPS = 5;

export interface ChatRunnerRouteHost {
  deps: ChatRunnerDeps;
  eventBridge: ChatRunnerEventBridge;
  activatedTools: Set<string>;
  getConversationSessionId(): string | null;
  getSessionCwd(): string | null;
  getNativeAgentLoopStatePath(): string | null;
  getProviderConfigBaseDir(): string;
  getSetupSecretIntake(): SetupSecretIntakeResult | null;
  getTurnLanguageHint(): TurnLanguageHint;
  setPendingSetupDialogue(dialogue: SetupDialogueRuntimeState): Promise<void>;
  setPendingRunSpecConfirmation(confirmation: RunSpecConfirmationState): Promise<void>;
  getSessionExecutionPolicy(): Promise<ExecutionPolicy>;
  setSessionExecutionPolicy(policy: ExecutionPolicy): void;
}

export async function executeRuntimeControlRoute(
  host: ChatRunnerRouteHost,
  route: Extract<SelectedChatRoute, { kind: "runtime_control" }>,
  runtimeControlContext: RuntimeControlChatContext | null,
  cwd: string,
  start: number
): Promise<ChatRunResult> {
  if (!host.deps.runtimeControlService) {
    return {
      success: false,
      output: "Runtime control is not available in this chat surface yet.",
      elapsed_ms: Date.now() - start,
    };
  }

  const replyTarget = runtimeControlContext?.replyTarget ?? host.deps.runtimeReplyTarget;
  const actor = runtimeControlContext?.actor ?? host.deps.runtimeControlActor;
  const result = await host.deps.runtimeControlService.request({
    intent: route.intent,
    cwd,
    requestedBy: actor ?? {
      surface: replyTarget?.surface ?? "chat",
      platform: replyTarget?.platform,
      conversation_id: replyTarget?.conversation_id,
      identity_key: replyTarget?.identity_key,
      user_id: replyTarget?.user_id,
    },
    replyTarget: replyTarget ?? { surface: "chat" },
    approvalFn: runtimeControlContext?.approvalFn
      ?? host.deps.runtimeControlApprovalFn
      ?? host.deps.approvalFn,
  });

  return {
    success: result.success,
    output: result.message,
    elapsed_ms: Date.now() - start,
  };
}

export async function executeRunSpecDraftRoute(
  host: ChatRunnerRouteHost,
  route: Extract<SelectedChatRoute, { kind: "run_spec_draft" }>,
  eventContext: ChatEventContext,
  assistantBuffer: AssistantBuffer,
  history: { appendAssistantMessage(message: string): Promise<void> },
  start: number,
): Promise<ChatRunResult> {
  const store = createRunSpecStore(host.deps.stateManager);
  await store.save(route.draft);
  const proposal = formatRunSpecSetupProposal(route.draft);
  const output = [
    proposal,
    "",
    "PulSeed prepared this as a typed long-running RunSpec draft. It has not started a daemon run.",
    "Reply with approval to confirm, cancel to discard it, or provide updated workspace/deadline/metric details.",
  ].join("\n");
  await host.setPendingRunSpecConfirmation({
    state: "pending",
    spec: route.draft,
    prompt: output,
    createdAt: route.draft.created_at,
    updatedAt: route.draft.updated_at,
  });
  host.eventBridge.emitCheckpoint("RunSpec confirmation pending", `${route.draft.id} is awaiting confirmation.`, eventContext, "route");
  return persistDirectRouteResult(host, output, eventContext, assistantBuffer, history, start);
}

export function formatBlockedRuntimeControlRoute(route: Extract<SelectedChatRoute, { kind: "runtime_control_blocked" }>): string {
  if (route.reason === "runtime_control_unclassified") {
    return [
      "Runtime control was requested explicitly, but PulSeed could not classify a supported typed lifecycle operation.",
      "The operation was not executed, and PulSeed will not fall back to shell tools for daemon or gateway lifecycle control.",
      "Use an exact supported runtime-control command or retry with a specific daemon, gateway, or run lifecycle action.",
    ].join("\n");
  }
  if (route.reason === "runtime_control_disallowed") {
    return [
      `Runtime control ${route.intent?.kind ?? "operation"} was recognized, but this chat surface is not authorized for runtime-control lifecycle actions.`,
      "The operation was not executed, and PulSeed will not fall back to shell tools for daemon or gateway lifecycle control.",
    ].join("\n");
  }
  return [
    `Runtime control ${route.intent?.kind ?? "operation"} was recognized, but the runtime-control service is not available in this chat surface.`,
    "The operation was not executed, and PulSeed will not fall back to shell tools for daemon or gateway lifecycle control.",
  ].join("\n");
}

export async function executeConfigureRoute(
  host: ChatRunnerRouteHost,
  route: SelectedChatRoute,
  eventContext: ChatEventContext,
  assistantBuffer: AssistantBuffer,
  history: { appendAssistantMessage(message: string): Promise<void> },
  start: number,
): Promise<ChatRunResult> {
  if (route.kind !== "configure") {
    throw new Error(`executeConfigureRoute received route kind ${route.kind}`);
  }
  const output = await formatConfigureGuidance(host, route.intent.configure_target ?? "unknown", host.getSetupSecretIntake(), host.getTurnLanguageHint(), eventContext);
  return persistDirectRouteResult(host, output, eventContext, assistantBuffer, history, start);
}

export async function executeClarifyRoute(
  host: ChatRunnerRouteHost,
  _route: SelectedChatRoute,
  eventContext: ChatEventContext,
  assistantBuffer: AssistantBuffer,
  history: { appendAssistantMessage(message: string): Promise<void> },
  start: number,
): Promise<ChatRunResult> {
  const output = [
    "I need one more detail before taking action.",
    "",
    "Tell me whether you want setup guidance, a configuration flow, or a code/test change.",
  ].join("\n");
  return persistDirectRouteResult(host, output, eventContext, assistantBuffer, history, start);
}

export async function executeAssistRoute(
  host: ChatRunnerRouteHost,
  params: {
    input: string;
    priorTurns: Array<{ role: string; content: string }>;
    eventContext: ChatEventContext;
    assistantBuffer: AssistantBuffer;
    history: { appendAssistantMessage(message: string): Promise<void>; recordUsage(phase: string, usage: ChatUsageCounter): void };
    start: number;
  },
): Promise<ChatRunResult> {
  if (!host.deps.llmClient) {
    return persistDirectRouteResult(
      host,
      "I can answer this as guidance, but no language model is configured for read-only chat.",
      params.eventContext,
      params.assistantBuffer,
      params.history,
      params.start,
    );
  }
  host.eventBridge.emitCheckpoint("Read-only assist selected", "The message will be answered without coding-agent execution.", params.eventContext, "route");
  const messages: LLMMessage[] = [
    ...params.priorTurns.map((m): LLMMessage => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    { role: "user", content: params.input },
  ];
  const response = await sendLLMMessage(host, host.deps.llmClient, messages, {
    system: [
      "Answer read-only. Provide concise operational guidance. Do not ask to edit files or run commands unless the user explicitly asks for execution.",
      sameLanguageResponseInstruction(host.getTurnLanguageHint()),
    ].join(" "),
    max_tokens: 1000,
    temperature: 0,
  }, params.assistantBuffer, params.eventContext);
  const usage = usageFromLLMResponse(response);
  if (hasUsage(usage)) params.history.recordUsage("assist", usage);
  return persistDirectRouteResult(
    host,
    params.assistantBuffer.text || response.content || "(no response)",
    params.eventContext,
    params.assistantBuffer,
    params.history,
    params.start,
  );
}

export async function executeAgentLoopRoute(
  host: ChatRunnerRouteHost,
  params: {
    resumeOnly: boolean;
    executionCwd: string;
    executionGoalId?: string;
    basePrompt: string;
    priorTurns: Array<{ role: string; content: string }>;
    agentLoopSystemPrompt: string;
    assistantBuffer: AssistantBuffer;
    eventContext: ChatEventContext;
    history: {
      appendAssistantMessage(message: string): Promise<void>;
      recordUsage(phase: string, usage: ChatUsageCounter): void;
    };
    gitRoot: string;
    activeAbortSignal: AbortSignal;
    start: number;
  }
): Promise<ChatRunResult> {
  const {
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
    activeAbortSignal,
    start,
  } = params;
  try {
    const resumeState = resumeOnly ? await loadResumableAgentLoopState(host) : null;
    if (resumeOnly && !resumeState) {
      const elapsed_ms = Date.now() - start;
      const output = await host.eventBridge.emitLifecycleErrorEventWithFallback(
        "No resumable native agentloop state found.",
        assistantBuffer.text,
        eventContext,
        {
          code: "resume_state_missing",
          stoppedReason: "resume_state_missing",
        },
        host.deps.llmClient
      );
      host.eventBridge.emitLifecycleEndEvent("error", elapsed_ms, eventContext, false);
      return {
        success: false,
        output,
        elapsed_ms,
      };
    }
    host.eventBridge.emitCheckpoint(resumeOnly ? "Session resumed" : "Agent loop started", resumeOnly
      ? "Resumable agent-loop state is loaded."
      : "The agent loop can now inspect, plan, edit, or verify with visible tool activity.", eventContext, "execution");
    host.eventBridge.emitActivity("lifecycle", "Calling model...", eventContext, "lifecycle:model");
    const result = await host.deps.chatAgentLoopRunner!.execute({
      message: basePrompt,
      cwd: executionCwd,
      goalId: executionGoalId,
      history: priorTurns.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
      eventSink: host.eventBridge.createAgentLoopEventSink(eventContext),
      approvalFn: async (request) => {
        if (host.deps.approvalFn) {
          return host.deps.approvalFn(request.reason);
        }
        return false;
      },
      toolCallContext: {
        executionPolicy: await host.getSessionExecutionPolicy(),
        ...(host.getConversationSessionId() ? { conversationSessionId: host.getConversationSessionId()! } : {}),
      },
      ...(host.getNativeAgentLoopStatePath() ? { resumeStatePath: host.getNativeAgentLoopStatePath()! } : {}),
      ...(resumeState ? { resumeState } : {}),
      ...(resumeOnly ? { resumeOnly: true } : {}),
      ...(agentLoopSystemPrompt ? { systemPrompt: agentLoopSystemPrompt } : {}),
      abortSignal: activeAbortSignal,
    });
    const elapsed_ms = Date.now() - start;
    const agentLoopUsage = result.agentLoop?.usage
      ? normalizeUsageCounter(result.agentLoop.usage)
      : zeroUsageCounter();
    if (hasUsage(agentLoopUsage)) {
      history.recordUsage("agentloop", agentLoopUsage);
    }
    if (result.output) {
      host.eventBridge.pushAssistantDelta(result.output, assistantBuffer, eventContext);
    }
    if (result.success) {
      const diffArtifact = await collectGitDiffArtifact(gitRoot);
      if (diffArtifact) {
        host.eventBridge.emitDiffArtifact(diffArtifact, eventContext);
      }
      await history.appendAssistantMessage(result.output);
      host.eventBridge.emitCheckpoint("Response ready", "The agent-loop response has been persisted for this turn.", eventContext, "complete");
      host.eventBridge.emitActivity("lifecycle", "Finalizing response...", eventContext, "lifecycle:finalizing");
      host.eventBridge.emitEvent({
        type: "assistant_final",
        text: result.output,
        persisted: true,
        ...host.eventBridge.eventBase(eventContext),
      });
      host.eventBridge.emitLifecycleEndEvent("completed", elapsed_ms, eventContext, true);
    } else {
      result.output = await host.eventBridge.emitLifecycleErrorEventWithFallback(
        result.output || result.error || "Unknown error",
        assistantBuffer.text,
        eventContext,
        {
          stoppedReason: result.stopped_reason,
          agentLoopStopReason: result.agentLoop?.stopReason,
        },
        host.deps.llmClient
      );
      host.eventBridge.emitLifecycleEndEvent("error", elapsed_ms, eventContext, false);
    }
    return {
      success: result.success,
      output: result.output,
      elapsed_ms,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output = await host.eventBridge.emitLifecycleErrorEventWithFallback(
      message,
      assistantBuffer.text,
      eventContext,
      {},
      host.deps.llmClient
    );
    host.eventBridge.emitLifecycleEndEvent("error", Date.now() - start, eventContext, false);
    return {
      success: false,
      output,
      elapsed_ms: Date.now() - start,
    };
  }
}

export async function executeToolLoopRoute(
  host: ChatRunnerRouteHost,
  params: {
    prompt: string;
    eventContext: ChatEventContext;
    assistantBuffer: AssistantBuffer;
    systemPrompt?: string;
    executionGoalId?: string;
    history: {
      appendAssistantMessage(message: string): Promise<void>;
      recordUsage(phase: string, usage: ChatUsageCounter): void;
    };
    gitRoot: string;
    start: number;
  }
): Promise<ChatRunResult> {
  try {
    host.eventBridge.emitCheckpoint("Tool loop started", "The model will choose tools from the active catalog.", params.eventContext, "execution");
    const toolResult = await executeWithTools(
      host,
      params.prompt,
      params.eventContext,
      params.assistantBuffer,
      params.systemPrompt,
      params.executionGoalId
    );
    const elapsed_ms = Date.now() - params.start;
    if (hasUsage(toolResult.usage)) {
      params.history.recordUsage("execution", toolResult.usage);
    }
    const diffArtifact = await collectGitDiffArtifact(params.gitRoot);
    if (diffArtifact) {
      host.eventBridge.emitDiffArtifact(diffArtifact, params.eventContext);
    }
    await params.history.appendAssistantMessage(toolResult.output);
    host.eventBridge.emitCheckpoint("Response ready", "The tool-loop response has been persisted for this turn.", params.eventContext, "complete");
    host.eventBridge.emitActivity("lifecycle", "Finalizing response...", params.eventContext, "lifecycle:finalizing");
    host.eventBridge.emitEvent({
      type: "assistant_final",
      text: toolResult.output,
      persisted: true,
      ...host.eventBridge.eventBase(params.eventContext),
    });
    host.eventBridge.emitLifecycleEndEvent("completed", elapsed_ms, params.eventContext, true);
    return { success: true, output: toolResult.output, elapsed_ms };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output = await host.eventBridge.emitLifecycleErrorEventWithFallback(
      message,
      params.assistantBuffer.text,
      params.eventContext,
      {},
      host.deps.llmClient
    );
    host.eventBridge.emitLifecycleEndEvent("error", Date.now() - params.start, params.eventContext, false);
    return {
      success: false,
      output,
      elapsed_ms: Date.now() - params.start,
    };
  }
}

export async function executeAdapterRoute(
  host: ChatRunnerRouteHost,
  params: {
    prompt: string;
    cwd: string;
    timeoutMs: number;
    systemPrompt?: string;
    eventContext: ChatEventContext;
    assistantBuffer: AssistantBuffer;
    gitRoot: string;
    start: number;
    history: {
      appendAssistantMessage(message: string): Promise<void>;
    };
  }
): Promise<ChatRunResult> {
  const task: AgentTask = {
    prompt: params.prompt,
    timeout_ms: params.timeoutMs,
    adapter_type: host.deps.adapter.adapterType,
    cwd: params.cwd,
    ...(params.systemPrompt ? { system_prompt: params.systemPrompt } : {}),
  };
  const resolvedTimeoutMs = task.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  host.eventBridge.emitCheckpoint("Adapter started", "The configured adapter has the current prompt and project context.", params.eventContext, "execution");
  host.eventBridge.emitActivity("lifecycle", "Calling adapter...", params.eventContext, "lifecycle:adapter");
  const adapterPromise = host.deps.adapter.execute(task);
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Chat adapter timed out after ${resolvedTimeoutMs}ms`)), resolvedTimeoutMs)
  );
  let result: Awaited<ReturnType<IAdapter["execute"]>>;
  try {
    result = await Promise.race([adapterPromise, timeoutPromise]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const output = await host.eventBridge.emitLifecycleErrorEventWithFallback(
      message,
      params.assistantBuffer.text,
      params.eventContext,
      {},
      host.deps.llmClient
    );
    const timeoutElapsedMs = Date.now() - params.start;
    host.eventBridge.emitLifecycleEndEvent("error", timeoutElapsedMs, params.eventContext, false);
    return {
      success: false,
      output,
      elapsed_ms: timeoutElapsedMs,
    };
  }
  if (!result.output && result.error) {
    result = { ...result, output: `Error: ${result.error}` };
  }
  const elapsed_ms = Date.now() - params.start;
  if (result.output) {
    host.eventBridge.pushAssistantDelta(result.output, params.assistantBuffer, params.eventContext);
  }

  const diffArtifact = await collectGitDiffArtifact(params.gitRoot);
  if (diffArtifact) {
    let retries = 0;
    const VERIFY_TIMEOUT_MS = 30_000;
    host.eventBridge.emitCheckpoint("Changes detected", "Verification is starting because the turn changed the working tree.", params.eventContext, "changes");
    host.eventBridge.emitActivity("lifecycle", "Checking result...", params.eventContext, "lifecycle:checking");
    let verification = await Promise.race([
      verifyChatAction(params.gitRoot, host.deps.toolExecutor, { force: true }),
      new Promise<{ passed: true }>((resolve) =>
        setTimeout(() => resolve({ passed: true }), VERIFY_TIMEOUT_MS)
      ),
    ]);

    while (!verification.passed && retries < MAX_VERIFY_RETRIES) {
      retries++;
      host.eventBridge.emitCheckpoint("Verification retry", `Attempt ${retries} of ${MAX_VERIFY_RETRIES} is repairing failed checks.`, params.eventContext, `verification-retry-${retries}`);
      const retryPrompt = `The previous changes caused test failures. Please fix them.\n\nTest output:\n${verification.testOutput ?? verification.errors.join("\n")}`;
      const retryTask: AgentTask = { ...task, prompt: retryPrompt };
      result = await host.deps.adapter.execute(retryTask);
      verification = await verifyChatAction(params.gitRoot, host.deps.toolExecutor, { force: true });
    }

    if (!verification.passed) {
      const finalDiffArtifact = await collectGitDiffArtifact(params.gitRoot);
      if (finalDiffArtifact) {
        host.eventBridge.emitDiffArtifact(finalDiffArtifact, params.eventContext);
      }
      host.eventBridge.emitCheckpoint("Verification failed", `Checks are still failing after ${MAX_VERIFY_RETRIES} retries.`, params.eventContext, "verification");
      const failureOutput = await host.eventBridge.emitLifecycleErrorEventWithFallback(
        `Changes applied but tests are still failing after ${MAX_VERIFY_RETRIES} retries.`,
        params.assistantBuffer.text,
        params.eventContext,
        {
          code: "verification_failed",
          signals: [{ kind: "verification", status: "failed" }],
        },
        host.deps.llmClient
      );
      host.eventBridge.emitLifecycleEndEvent("error", Date.now() - params.start, params.eventContext, false);
      return {
        success: false,
        output: `${failureOutput}\n\nTest output:\n${verification.testOutput ?? verification.errors.join("\n")}`.trim(),
        elapsed_ms: Date.now() - params.start,
      };
    }
    const finalDiffArtifact = await collectGitDiffArtifact(params.gitRoot);
    if (finalDiffArtifact) {
      host.eventBridge.emitDiffArtifact(finalDiffArtifact, params.eventContext);
    }
    host.eventBridge.emitCheckpoint("Verification passed", "Changed files passed the configured chat verification.", params.eventContext, "verification");
  }

  if (result.success) {
    await params.history.appendAssistantMessage(result.output);
    host.eventBridge.emitCheckpoint("Response ready", "The assistant response has been persisted for this turn.", params.eventContext, "complete");
    host.eventBridge.emitActivity("lifecycle", "Finalizing response...", params.eventContext, "lifecycle:finalizing");
    host.eventBridge.emitEvent({
      type: "assistant_final",
      text: result.output,
      persisted: true,
      ...host.eventBridge.eventBase(params.eventContext),
    });
    host.eventBridge.emitLifecycleEndEvent("completed", elapsed_ms, params.eventContext, true);
  } else {
    const partialText = params.assistantBuffer.text !== result.output ? params.assistantBuffer.text : "";
    result.output = await host.eventBridge.emitLifecycleErrorEventWithFallback(
      result.output || result.error || "Unknown error",
      partialText,
      params.eventContext,
      {
        stoppedReason: result.stopped_reason,
        signals: [{
          kind: "adapter",
          adapterType: host.deps.adapter.adapterType,
          stoppedReason: result.stopped_reason,
        }],
      },
      host.deps.llmClient
    );
    host.eventBridge.emitLifecycleEndEvent("error", elapsed_ms, params.eventContext, false);
  }

  return {
    success: result.success,
    output: result.output,
    elapsed_ms,
  };
}

async function executeWithTools(
  host: ChatRunnerRouteHost,
  prompt: string,
  eventContext: ChatEventContext,
  assistantBuffer: AssistantBuffer,
  systemPrompt?: string,
  goalId?: string
): Promise<{ output: string; usage: ChatUsageCounter }> {
  const llmClient = host.deps.llmClient!;
  const messages: LLMMessage[] = [{ role: "user", content: prompt }];
  const toolCallContext = await buildToolCallContext(host, goalId);
  const usage = zeroUsageCounter();

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    const tools = host.deps.registry
      ? toToolDefinitionsFiltered(host.deps.registry.listAll(), { activatedTools: host.activatedTools })
      : [];
    const supportsNativeToolCalling = llmClient.supportsToolCalling?.() !== false;
    let response: LLMResponse;
    try {
      host.eventBridge.emitActivity("lifecycle", "Calling model...", eventContext, "lifecycle:model");
      response = await sendLLMMessage(host, llmClient, messages, {
        ...(supportsNativeToolCalling
          ? { tools, ...(systemPrompt ? { system: systemPrompt } : {}) }
          : { system: buildPromptedToolProtocolSystemPrompt({ systemPrompt, tools }) }),
      }, assistantBuffer, eventContext);
    } catch (err) {
      console.error("[chat-runner] executeWithTools error:", err);
      const hint = err instanceof Error ? `: ${err.message}` : "";
      throw new Error(`Sorry, I encountered an error processing your request${hint}.`);
    }
    addUsageCounter(usage, usageFromLLMResponse(response));

    const toolCalls = response.tool_calls?.length
      ? response.tool_calls
      : supportsNativeToolCalling
        ? []
        : extractPromptedToolCalls({
            content: response.content,
            tools,
            createId: () => `prompted-${loop}-${crypto.randomUUID()}`,
          }).map((call): ToolCallResult => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.input ?? {}),
            },
          }));

    if (!supportsNativeToolCalling && toolCalls.length > 0) {
      assistantBuffer.text = "";
    }

    if (toolCalls.length === 0) {
      return {
        output: assistantBuffer.text || response.content || "(no response)",
        usage,
      };
    }

    messages.push({ role: "assistant", content: response.content || "" });

    for (const tc of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        // ignore parse errors, use empty args
      }
      const toolResult = await dispatchToolCall(
        host,
        tc.id,
        tc.function.name,
        args,
        toolCallContext,
        eventContext
      );
      if (tc.function.name === "tool_search") {
        activateToolSearchResults(host.activatedTools, toolResult);
      }
      messages.push({ role: "user", content: `Tool result for ${tc.function.name}:\n${toolResult}` });
    }
  }

  const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
  return {
    output: lastAssistant?.content || "I was unable to complete the request within the allowed tool call limit.",
    usage,
  };
}

async function persistDirectRouteResult(
  host: ChatRunnerRouteHost,
  output: string,
  eventContext: ChatEventContext,
  assistantBuffer: AssistantBuffer,
  history: { appendAssistantMessage(message: string): Promise<void> },
  start: number,
): Promise<ChatRunResult> {
  const elapsed_ms = Date.now() - start;
  if (!assistantBuffer.text) {
    host.eventBridge.pushAssistantDelta(output, assistantBuffer, eventContext);
  }
  await history.appendAssistantMessage(output);
  host.eventBridge.emitActivity("lifecycle", "Finalizing response...", eventContext, "lifecycle:finalizing");
  host.eventBridge.emitEvent({
    type: "assistant_final",
    text: output,
    persisted: true,
    ...host.eventBridge.eventBase(eventContext),
  });
  host.eventBridge.emitLifecycleEndEvent("completed", elapsed_ms, eventContext, true);
  return { success: true, output, elapsed_ms };
}

async function formatConfigureGuidance(
  host: ChatRunnerRouteHost,
  target: "telegram_gateway" | "gateway" | "provider" | "daemon" | "notification" | "slack" | "unknown",
  setupSecretIntake: SetupSecretIntakeResult | null = null,
  languageHint: TurnLanguageHint,
  eventContext: ChatEventContext,
): Promise<string> {
  const suppliedSecretKinds = setupSecretIntake?.suppliedSecrets.map((secret) => secret.kind) ?? [];
  if (target === "telegram_gateway") {
    const provider = host.deps.gatewaySetupStatusProvider ?? createGatewaySetupStatusProvider();
    await host.eventBridge.emitOperationProgressAndFlush(createOperationProgressItem({
      id: "telegram-configure:started",
      kind: "started",
      operation: "telegram_setup",
      title: shouldRenderJapanese(languageHint) ? "Telegram setup を開始しました" : "Started Telegram setup",
      detail: shouldRenderJapanese(languageHint) ? "daemon と gateway config の状態を確認します。" : "Checking daemon and gateway config state.",
      createdAt: new Date().toISOString(),
      languageHint,
    }), eventContext);
    const status = await provider.getTelegramStatus(host.getProviderConfigBaseDir());
    await host.eventBridge.emitOperationProgressAndFlush(createOperationProgressItem({
      id: "telegram-configure:checked-status",
      kind: "checked_status",
      operation: "telegram_setup",
      title: shouldRenderJapanese(languageHint) ? "Daemon status を確認しました" : "Checked daemon status",
      detail: status.daemon.running
        ? shouldRenderJapanese(languageHint)
          ? `port ${status.daemon.port} で起動中です。`
          : `Running on port ${status.daemon.port}.`
        : shouldRenderJapanese(languageHint)
          ? `port ${status.daemon.port} で応答していません。`
          : `Not responding on port ${status.daemon.port}.`,
      createdAt: new Date().toISOString(),
      languageHint,
      metadata: {
        daemon_running: status.daemon.running,
        daemon_port: status.daemon.port,
      },
    }), eventContext);
    await host.eventBridge.emitOperationProgressAndFlush(createOperationProgressItem({
      id: "telegram-configure:read-config",
      kind: "read_config",
      operation: "telegram_setup",
      title: shouldRenderJapanese(languageHint) ? "Telegram config を読み取りました" : "Read Telegram config",
      detail: formatTelegramConfigProgressDetail(status, languageHint),
      createdAt: new Date().toISOString(),
      languageHint,
      metadata: {
        config_exists: status.config.exists,
        has_bot_token: status.config.hasBotToken,
        has_home_chat: status.config.hasHomeChat,
      },
    }), eventContext);
    const suppliedTelegramToken = suppliedSecretKinds.includes("telegram_bot_token");
    const telegramSecret = setupSecretIntake?.suppliedSecrets.find((secret) => secret.kind === "telegram_bot_token");
    if (telegramSecret) {
      await host.setPendingSetupDialogue(createTelegramConfirmWriteDialogue(telegramSecret, {
        replacesExistingSecret: status.config.hasBotToken,
      }));
    }
    await host.eventBridge.emitOperationProgressAndFlush(createOperationProgressItem({
      id: "telegram-configure:planned-action",
      kind: telegramSecret ? "awaiting_approval" : "planned_action",
      operation: "telegram_setup",
      title: shouldRenderJapanese(languageHint) ? "次の手順を準備しました" : "Prepared next setup step",
      detail: telegramSecret
        ? shouldRenderJapanese(languageHint)
          ? status.config.hasBotToken
            ? "redacted token から approval-gated config write を準備しました。confirm すると既存 token を置き換えます。"
            : "redacted token から approval-gated config write を準備しました。"
          : status.config.hasBotToken
            ? "Prepared an approval-gated config write from the redacted token. Confirming will replace the existing token."
            : "Prepared an approval-gated config write from the redacted token."
        : shouldRenderJapanese(languageHint)
          ? "guidance を返します。token が貼られた場合は redaction 後に confirmation を準備します。"
          : "Returning guidance. If a token is pasted, PulSeed will redact it and prepare confirmation.",
      createdAt: new Date().toISOString(),
      languageHint,
      metadata: {
        pending_write: telegramSecret !== undefined,
      },
    }), eventContext);
    return formatTelegramConfigureGuidance(status, suppliedTelegramToken, telegramSecret !== undefined, languageHint);
  }
  if (target === "gateway") {
    const discordSecret = setupSecretIntake?.suppliedSecrets.find((secret) => secret.kind === "discord_bot_token");
    if (discordSecret) {
      const dialogue = createDiscordAdapterPlanDialogue();
      await host.setPendingSetupDialogue({ publicState: dialogue });
      if (shouldRenderJapanese(languageHint)) {
        return [
          "Discord gateway setup plan",
          "",
          "- Setup dialogue state: blocked.",
          "- Selected channel: discord.",
          "- Discord bot token は受け取り redacted しましたが、chat-assisted config write を安全に準備するには application ID、home channel ID、identity key、webhook host/port、access policy が必要です。",
          "",
          "Recommended command path:",
          "```sh",
          dialogue.action?.command ?? "pulseed gateway setup",
          "pulseed daemon start",
          "pulseed daemon status",
          "```",
          "",
          "Telegram と同じ typed setup dialogue contract を使っていますが、Discord は不足している non-secret field を安全に集められるまで adapter-plan path のままです。",
        ].join("\n");
      }
      return [
        "Discord gateway setup plan",
        "",
        "- Setup dialogue state: blocked.",
        "- Selected channel: discord.",
        "- A Discord bot token was supplied and redacted, but PulSeed needs application ID, home channel ID, identity key, webhook host/port, and access policy before a chat-assisted config write can be safe.",
        "",
        "Recommended command path:",
        "```sh",
        dialogue.action?.command ?? "pulseed gateway setup",
        "pulseed daemon start",
        "pulseed daemon status",
        "```",
        "",
        "This uses the same typed setup dialogue contract as Telegram, but Discord remains an adapter-plan path until the missing non-secret fields can be collected safely.",
      ].join("\n");
    }
    if (shouldRenderJapanese(languageHint)) {
      return [
        "Gateway setup は configuration flow です。",
        "",
        "`pulseed gateway setup` を実行し、その後 `pulseed daemon start` で daemon を起動または再起動してください。",
      ].join("\n");
    }
    return [
      "Gateway setup is a configuration flow.",
      "",
      "Run `pulseed gateway setup`, then start or restart the daemon with `pulseed daemon start`.",
    ].join("\n");
  }
  if (shouldRenderJapanese(languageHint)) {
    return [
      "これは code-edit task ではなく、setup/configuration のリクエストに見えます。",
      "",
      "main wizard には `pulseed setup`、chat channel には `pulseed gateway setup`、利用可能な場合は channel-specific setup command を使ってください。",
    ].join("\n");
  }
  return [
    "This looks like setup/configuration rather than a code-edit task.",
    "",
    "Use `pulseed setup` for the main wizard, `pulseed gateway setup` for chat channels, or the channel-specific setup command when available.",
  ].join("\n");
}

function formatTelegramConfigProgressDetail(status: TelegramSetupStatus, languageHint: TurnLanguageHint): string {
  if (shouldRenderJapanese(languageHint)) {
    if (!status.config.exists) return "config file はまだありません。";
    if (!status.config.hasBotToken) return "config file はありますが bot token が未設定です。";
    if (!status.config.hasHomeChat) return "bot token は設定済みですが home chat が未設定です。";
    return "bot token と home chat は設定済みです。";
  }
  if (!status.config.exists) return "Config file does not exist yet.";
  if (!status.config.hasBotToken) return "Config file exists, but no bot token is configured.";
  if (!status.config.hasHomeChat) return "Bot token is configured, but no home chat is set.";
  return "Bot token and home chat are configured.";
}

function formatTelegramConfigureGuidance(
  status: TelegramSetupStatus,
  suppliedTelegramToken: boolean,
  pendingActionCreated: boolean,
  languageHint: TurnLanguageHint
): string {
  if (shouldRenderJapanese(languageHint)) {
    return formatTelegramConfigureGuidanceJa(status, suppliedTelegramToken, pendingActionCreated);
  }
  const lines = [
    "Telegram gateway status",
    "",
    status.daemon.running
      ? `- Daemon: running on port ${status.daemon.port}; gateway load state is not proven from chat status.`
      : `- Daemon: not responding on port ${status.daemon.port}.`,
  ];

  if (status.state === "unconfigured") {
    lines.push(
      "- Telegram: not configured.",
      "",
      "Recommended command path:",
      "```sh",
      "pulseed telegram setup",
      "pulseed gateway setup",
      "pulseed daemon start",
      "pulseed daemon status",
      "```",
      "",
      "Create or open a bot with @BotFather, then enter the token in `pulseed telegram setup`."
    );
  } else if (status.state === "partially_configured") {
    lines.push(
      "- Telegram config: bot token is configured, but no home chat is set.",
      "- Gateway loaded in daemon: unknown from chat status.",
      "",
      "Next step:",
      "- Send `/sethome` to the Telegram bot from the chat that should receive PulSeed replies.",
      "- Then run `pulseed daemon status` to verify the gateway."
    );
  } else {
    lines.push(
      "- Telegram config: configured.",
      status.config.hasHomeChat
        ? "- Home chat: configured."
        : "- Home chat: not set; send `/sethome` if this bot should reply into a specific chat.",
      "- Gateway loaded in daemon: unknown from chat status.",
      "",
      "Verification:",
      "- Send a message to the Telegram bot.",
      "- Run `pulseed daemon status` if delivery does not work."
    );
  }

  lines.push(
    "",
    suppliedTelegramToken
      ? pendingActionCreated
        ? status.config.hasBotToken
          ? `I received a Telegram bot token in this turn and kept it redacted from chat history and activity. Confirming will replace the existing configured token. Reply \`${SETUP_WRITE_CONFIRM_COMMAND}\` or approve in natural language to request an approval-gated config write.`
          : `I received a Telegram bot token in this turn and kept it redacted from chat history and activity. Reply \`${SETUP_WRITE_CONFIRM_COMMAND}\` or approve in natural language to request an approval-gated config write.`
        : "I received a Telegram bot token in this turn and kept it redacted from chat history and activity, but no setup action could be prepared."
      : "If you prefer chat-assisted setup, paste the token here; PulSeed will redact it from history and prepare an approval-gated confirmation before writing config."
  );

  if (!status.daemon.running && status.state !== "unconfigured") {
    lines.push(
      "",
      "The config will not take effect until the daemon is started or restarted."
    );
  } else if (status.daemon.running && status.state !== "unconfigured") {
    lines.push(
      "",
      "If Telegram was configured or changed through chat-assisted setup, PulSeed will request an internal gateway refresh after the approved write.",
      "For config changes made outside PulSeed chat setup, run `pulseed daemon restart` if delivery does not pick up the updated gateway config."
    );
  }

  return lines.join("\n");
}

function formatTelegramConfigureGuidanceJa(
  status: TelegramSetupStatus,
  suppliedTelegramToken: boolean,
  pendingActionCreated: boolean
): string {
  const lines = [
    "Telegram gateway status",
    "",
    status.daemon.running
      ? `- Daemon: port ${status.daemon.port} で起動中です。chat status だけでは gateway の load state までは確定できません。`
      : `- Daemon: port ${status.daemon.port} で応答していません。`,
  ];

  if (status.state === "unconfigured") {
    lines.push(
      "- Telegram: まだ設定されていません。",
      "",
      "Recommended command path:",
      "```sh",
      "pulseed telegram setup",
      "pulseed gateway setup",
      "pulseed daemon start",
      "pulseed daemon status",
      "```",
      "",
      "@BotFather で bot を作成または開き、`pulseed telegram setup` で token を入力してください。"
    );
  } else if (status.state === "partially_configured") {
    lines.push(
      "- Telegram config: bot token は設定済みですが、home chat が未設定です。",
      "- Gateway loaded in daemon: chat status からは未確認です。",
      "",
      "Next step:",
      "- PulSeed の返信先にしたい Telegram chat から bot に `/sethome` を送ってください。",
      "- その後 `pulseed daemon status` で gateway を確認してください。"
    );
  } else {
    lines.push(
      "- Telegram config: 設定済みです。",
      status.config.hasHomeChat
        ? "- Home chat: 設定済みです。"
        : "- Home chat: 未設定です。この bot が特定 chat に返信する必要がある場合は `/sethome` を送ってください。",
      "- Gateway loaded in daemon: chat status からは未確認です。",
      "",
      "Verification:",
      "- Telegram bot にメッセージを送ってください。",
      "- 配信されない場合は `pulseed daemon status` を実行してください。"
    );
  }

  lines.push(
    "",
    suppliedTelegramToken
      ? pendingActionCreated
        ? status.config.hasBotToken
          ? `この turn で Telegram bot token を受け取り、chat history と activity には redacted のまま保持しました。confirm すると既存の configured token を置き換えます。approval-gated config write を依頼するには \`${SETUP_WRITE_CONFIRM_COMMAND}\` または自然文で承認してください。`
          : `この turn で Telegram bot token を受け取り、chat history と activity には redacted のまま保持しました。approval-gated config write を依頼するには \`${SETUP_WRITE_CONFIRM_COMMAND}\` または自然文で承認してください。`
        : "この turn で Telegram bot token を受け取り、chat history と activity には redacted のまま保持しましたが、setup action は準備できませんでした。"
      : "chat-assisted setup を使う場合は、ここに token を貼ってください。PulSeed は history から redaction し、config 書き込み前に approval-gated confirmation を準備します。"
  );

  if (!status.daemon.running && status.state !== "unconfigured") {
    lines.push(
      "",
      "config は daemon を起動または再起動するまで反映されません。"
    );
  } else if (status.daemon.running && status.state !== "unconfigured") {
    lines.push(
      "",
      "chat-assisted setup で Telegram config を追加または変更した場合は、承認済み write 後に PulSeed が internal gateway refresh を要求します。",
      "PulSeed chat setup 以外で config を変更した場合、配信が最新 gateway config を拾わなければ `pulseed daemon restart` を実行してください。"
    );
  }

  return lines.join("\n");
}

async function dispatchToolCall(
  host: ChatRunnerRouteHost,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
  context: ToolCallContext,
  eventContext: ChatEventContext,
): Promise<string> {
  if (!host.deps.registry) {
    host.eventBridge.emitActivity("tool", formatToolActivity("Failed", name, "No tool registry configured"), eventContext, toolCallId);
    return JSON.stringify({ error: "No tool registry configured" });
  }
  const tool = host.deps.registry.get(name);
  if (!tool) {
    host.eventBridge.emitActivity("tool", formatToolActivity("Failed", name, `Unknown tool: ${name}`), eventContext, toolCallId);
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
  const startTime = Date.now();
  try {
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      host.eventBridge.emitActivity("tool", formatToolActivity("Failed", name, `Invalid input: ${parsed.error.message}`), eventContext, toolCallId);
      host.eventBridge.emitEvent({
        type: "tool_end",
        toolCallId,
        toolName: name,
        success: false,
        summary: `Invalid input: ${parsed.error.message}`,
        durationMs: Date.now() - startTime,
        ...host.eventBridge.eventBase(eventContext),
      });
      return JSON.stringify({ error: `Invalid input: ${parsed.error.message}` });
    }

    host.eventBridge.emitEvent({
      type: "tool_start",
      toolCallId,
      toolName: name,
      args,
      ...host.eventBridge.eventBase(eventContext),
    });
    host.eventBridge.emitActivity("tool", formatToolActivity("Running", name, JSON.stringify(args)), eventContext, toolCallId);

    let result: { success: boolean; summary: string; data?: unknown; error?: string };
    if (host.deps.toolExecutor) {
      host.eventBridge.emitEvent({
        type: "tool_update",
        toolCallId,
        toolName: name,
        status: "running",
        message: "running",
        ...host.eventBridge.eventBase(eventContext),
      });
      host.deps.onToolStart?.(name, args);
      result = await host.deps.toolExecutor.execute(name, parsed.data, context);
    } else {
      const permResult = await tool.checkPermissions(parsed.data, context);
      if (permResult.status === "denied") {
        host.eventBridge.emitEvent({
          type: "tool_end",
          toolCallId,
          toolName: name,
          success: false,
          summary: permResult.reason,
          durationMs: Date.now() - startTime,
          ...host.eventBridge.eventBase(eventContext),
        });
        return `Tool ${name} denied: ${permResult.reason}`;
      }
      if (permResult.status === "needs_approval") {
        host.eventBridge.emitActivity("tool", formatToolActivity("Running", name, `awaiting approval: ${permResult.reason}`), eventContext, toolCallId);
        host.eventBridge.emitEvent({
          type: "tool_update",
          toolCallId,
          toolName: name,
          status: "awaiting_approval",
          message: permResult.reason,
          ...host.eventBridge.eventBase(eventContext),
        });
        const approved = await context.approvalFn({
          toolName: name,
          input: parsed.data,
          reason: permResult.reason,
          permissionLevel: tool.metadata.permissionLevel,
          isDestructive: tool.metadata.isDestructive,
          reversibility: "unknown",
        });
        if (!approved) {
          host.eventBridge.emitEvent({
            type: "tool_end",
            toolCallId,
            toolName: name,
            success: false,
            summary: `Not approved: ${permResult.reason}`,
            durationMs: Date.now() - startTime,
            ...host.eventBridge.eventBase(eventContext),
          });
          return `Tool ${name} not approved: ${permResult.reason}`;
        }
      }
      host.eventBridge.emitEvent({
        type: "tool_update",
        toolCallId,
        toolName: name,
        status: "running",
        message: "running",
        ...host.eventBridge.eventBase(eventContext),
      });
      host.deps.onToolStart?.(name, args);
      result = await tool.call(parsed.data, context);
    }

    const durationMs = Date.now() - startTime;
    host.deps.onToolEnd?.(name, { success: result.success, summary: result.summary || "...", durationMs });
    host.eventBridge.emitActivity(
      "tool",
      formatToolActivity(result.success ? "Finished" : "Failed", name, result.summary || "..."),
      eventContext,
      toolCallId
    );
    host.eventBridge.emitEvent({
      type: "tool_update",
      toolCallId,
      toolName: name,
      status: "result",
      message: result.summary || "...",
      ...host.eventBridge.eventBase(eventContext),
    });
    host.eventBridge.emitEvent({
      type: "tool_end",
      toolCallId,
      toolName: name,
      success: result.success,
      summary: result.summary || "...",
      durationMs,
      ...host.eventBridge.eventBase(eventContext),
    });
    return result.data != null ? JSON.stringify(result.data) : (result.summary ?? "(no result)");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;
    host.deps.onToolEnd?.(name, { success: false, summary: message, durationMs });
    host.eventBridge.emitActivity("tool", formatToolActivity("Failed", name, message), eventContext, toolCallId);
    host.eventBridge.emitEvent({
      type: "tool_end",
      toolCallId,
      toolName: name,
      success: false,
      summary: message,
      durationMs,
      ...host.eventBridge.eventBase(eventContext),
    });
    return JSON.stringify({ error: `Tool ${name} failed: ${message}` });
  }
}

async function sendLLMMessage(
  host: ChatRunnerRouteHost,
  llmClient: ILLMClient,
  messages: LLMMessage[],
  options: LLMRequestOptions | undefined,
  assistantBuffer: AssistantBuffer,
  eventContext: ChatEventContext
): Promise<LLMResponse> {
  let streamed = false;
  if (llmClient.sendMessageStream) {
    const response = await llmClient.sendMessageStream(messages, options, {
      onTextDelta: (delta) => {
        streamed = true;
        host.eventBridge.pushAssistantDelta(delta, assistantBuffer, eventContext);
      },
    });
    if (!streamed && response.content) {
      host.eventBridge.pushAssistantDelta(response.content, assistantBuffer, eventContext);
    }
    return response;
  }

  const response = await llmClient.sendMessage(messages, options);
  if (response.content) {
    host.eventBridge.pushAssistantDelta(response.content, assistantBuffer, eventContext);
  }
  return response;
}

async function buildToolCallContext(host: ChatRunnerRouteHost, goalId = host.deps.goalId): Promise<ToolCallContext> {
  const executionPolicy = await host.getSessionExecutionPolicy();
  return {
    cwd: host.getSessionCwd() ?? process.cwd(),
    goalId: goalId ?? "",
    trustBalance: 0,
    preApproved: false,
    approvalFn: async (req) => {
      if (host.deps.approvalFn) {
        return host.deps.approvalFn(req.reason);
      }
      return false;
    },
    executionPolicy,
  };
}

async function loadResumableAgentLoopState(host: ChatRunnerRouteHost): Promise<AgentLoopSessionState | null> {
  if (!host.getNativeAgentLoopStatePath()) return null;
  const raw = await host.deps.stateManager.readRaw(host.getNativeAgentLoopStatePath()!);
  if (!isAgentLoopSessionState(raw)) return null;
  if (raw.status === "completed") return null;
  return {
    ...raw,
    messages: [...raw.messages],
    calledTools: [...raw.calledTools],
  };
}

function isAgentLoopSessionState(value: unknown): value is AgentLoopSessionState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["sessionId"] === "string"
    && typeof candidate["traceId"] === "string"
    && typeof candidate["turnId"] === "string"
    && typeof candidate["goalId"] === "string"
    && typeof candidate["cwd"] === "string"
    && typeof candidate["modelRef"] === "string"
    && Array.isArray(candidate["messages"])
    && Array.isArray(candidate["calledTools"])
    && typeof candidate["status"] === "string";
}

function activateToolSearchResults(activatedTools: Set<string>, toolResult: string): void {
  try {
    const parsed = JSON.parse(toolResult) as unknown;
    const results = Array.isArray(parsed) ? parsed : null;
    if (results) {
      for (const item of results) {
        if (item && typeof item === "object" && typeof (item as Record<string, unknown>)["name"] === "string") {
          activatedTools.add((item as Record<string, unknown>)["name"] as string);
        }
      }
    }
  } catch {
    // Non-JSON result or unexpected shape — ignore
  }
}

function zeroUsageCounter(): ChatUsageCounter {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function normalizeUsageCounter(usage: ChatUsageCounter): ChatUsageCounter {
  const inputTokens = Number.isFinite(usage.inputTokens) ? Math.max(0, Math.floor(usage.inputTokens)) : 0;
  const outputTokens = Number.isFinite(usage.outputTokens) ? Math.max(0, Math.floor(usage.outputTokens)) : 0;
  const totalTokens = Number.isFinite(usage.totalTokens)
    ? Math.max(0, Math.floor(usage.totalTokens))
    : inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function usageFromLLMResponse(response: LLMResponse): ChatUsageCounter {
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function addUsageCounter(target: ChatUsageCounter, delta: ChatUsageCounter): void {
  const normalizedDelta = normalizeUsageCounter(delta);
  target.inputTokens += normalizedDelta.inputTokens;
  target.outputTokens += normalizedDelta.outputTokens;
  target.totalTokens += normalizedDelta.totalTokens;
}

function hasUsage(usage: ChatUsageCounter): boolean {
  return usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0;
}

export async function resolveSessionExecutionPolicy(
  currentPolicy: ExecutionPolicy | null,
  sessionCwd: string | null
): Promise<ExecutionPolicy> {
  if (currentPolicy) return currentPolicy;
  const config = await loadProviderConfig({ saveMigration: false });
  return resolveExecutionPolicy({
    workspaceRoot: sessionCwd ?? process.cwd(),
    security: config.agent_loop?.security,
  });
}
