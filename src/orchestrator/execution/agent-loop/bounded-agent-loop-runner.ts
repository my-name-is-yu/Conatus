import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { execFileNoThrow } from "../../../base/utils/execFileNoThrow.js";
import type { z } from "zod";
import type { AgentLoopStopReason } from "./agent-loop-budget.js";
import type {
  AgentLoopMessage,
  AgentLoopModelClient,
  AgentLoopModelTurnProtocol,
  AgentLoopToolCall,
  AgentLoopToolObservation,
  AgentLoopToolObservationExecution,
  AgentLoopToolObservationState,
} from "./agent-loop-model.js";
import type { AgentLoopCommandResult, AgentLoopResult, AgentLoopToolResultSummary } from "./agent-loop-result.js";
import type { AgentLoopToolRuntime } from "./agent-loop-tool-runtime.js";
import type { AgentLoopToolRouter } from "./agent-loop-tool-router.js";
import type { AgentLoopTurnContext } from "./agent-loop-turn-context.js";
import { createAgentLoopHistory } from "./agent-loop-history.js";
import { formatAgentLoopModelRef } from "./agent-loop-model.js";
import type { AgentLoopCompactionPhase, AgentLoopCompactionReason, AgentLoopCompactor } from "./agent-loop-compactor.js";
import { ExtractiveAgentLoopCompactor } from "./agent-loop-compactor.js";
import type { AgentLoopCompactionRecord } from "./agent-loop-compaction-record.js";
import { cloneAgentLoopCompactionRecords } from "./agent-loop-compaction-record.js";
import { classifyAgentLoopCommandResult } from "./agent-loop-command-classifier.js";
import type { AgentLoopSessionState } from "./agent-loop-session-state.js";
import type { FunctionToolCallResponseItem } from "./response-item.js";
import {
  assistantTextResponseItem,
  functionToolCallResponseItem,
} from "./response-item.js";

export interface BoundedAgentLoopRunnerDeps {
  modelClient: AgentLoopModelClient;
  toolRouter: AgentLoopToolRouter;
  toolRuntime: AgentLoopToolRuntime;
  compactor?: AgentLoopCompactor;
}

interface FilesystemSnapshotEntry {
  size: number;
  mtimeMs: number;
  hash?: string;
}

type WorkspaceSnapshot =
  | { kind: "git"; paths: Set<string> }
  | { kind: "filesystem"; files: Map<string, FilesystemSnapshotEntry> };

const FILESYSTEM_SNAPSHOT_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "dist",
  "build",
]);
const FILESYSTEM_SNAPSHOT_MAX_FILES = 5_000;
const FILESYSTEM_SNAPSHOT_HASH_MAX_BYTES = 1_000_000;

export class BoundedAgentLoopRunner {
  private readonly compactor: AgentLoopCompactor;

  constructor(private readonly deps: BoundedAgentLoopRunnerDeps) {
    this.compactor = deps.compactor ?? new ExtractiveAgentLoopCompactor();
  }

  async run<TOutput>(turn: AgentLoopTurnContext<TOutput>): Promise<AgentLoopResult<TOutput>> {
    const startedAt = Date.now();
    const resumed = turn.resumeState
      ?? (turn.loadPersistedState === false ? null : await turn.session.stateStore.load());
    let modelTurns = resumed?.modelTurns ?? 0;
    let toolCalls = resumed?.toolCalls ?? 0;
    let consecutiveToolErrors = 0;
    let schemaRepairAttempts = 0;
    let completionValidationAttempts = resumed?.completionValidationAttempts ?? 0;
    let finalText = resumed?.finalText ?? "";
    let compactions = resumed?.compactions ?? 0;
    let compactionRecords = cloneAgentLoopCompactionRecords(resumed?.compactionRecords);
    const calledTools = new Set<string>(resumed?.calledTools ?? []);
    let lastToolLoopSignature: string | null = resumed?.lastToolLoopSignature ?? null;
    let repeatedToolLoopCount = resumed?.repeatedToolLoopCount ?? 0;
    const commandResults: AgentLoopCommandResult[] = [];
    const toolResultSummaries: AgentLoopToolResultSummary[] = [];
    const initialWorkspaceSnapshot = await this.captureWorkspaceSnapshot(turn.cwd);
    const stop = (
      reason: AgentLoopStopReason,
      startedAt: number,
      modelTurns: number,
      toolCalls: number,
      finalText: string,
      output: TOutput | null,
      success = false,
      compactions = 0,
      changedFiles: string[] = [],
      toolResults: AgentLoopToolResultSummary[] = [],
      commandResults: AgentLoopCommandResult[] = [],
      messages?: AgentLoopMessage[],
      calledTools?: Set<string>,
      lastToolLoopSignature?: string | null,
      repeatedToolLoopCount?: number,
      completionValidationAttempts?: number,
      reasonDetail?: string,
    ): Promise<AgentLoopResult<TOutput>> => this.stop(
      turn,
      reason,
      startedAt,
      modelTurns,
      toolCalls,
      finalText,
      output,
      success,
      compactions,
      changedFiles,
      toolResults,
      commandResults,
      messages,
      calledTools,
      lastToolLoopSignature,
      repeatedToolLoopCount,
      completionValidationAttempts,
      reasonDetail,
      compactionRecords,
    );

    await this.record(turn, {
      type: "started",
      ...this.baseEvent(turn),
    });

    if (resumed) {
      await this.record(turn, {
        type: "resumed",
        ...this.baseEvent(turn),
        fromUpdatedAt: resumed.updatedAt,
        restoredMessages: resumed.messages.length,
      });
    }

    let messages: AgentLoopMessage[] = resumed?.messages ? [...resumed.messages] : [...turn.messages];
    const preTurnCompaction = await this.compactIfNeeded(turn, messages, "pre_turn", "context_limit", undefined, compactions, compactionRecords);
    if (preTurnCompaction.error) {
        return stop("fatal_error", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, [], toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
    }
    messages = preTurnCompaction.messages;
    compactionRecords = preTurnCompaction.compactionRecords;
    compactions += preTurnCompaction.compacted ? 1 : 0;
    await this.saveState(turn, messages, compactionRecords, modelTurns, toolCalls, compactions, completionValidationAttempts, calledTools, lastToolLoopSignature, repeatedToolLoopCount, finalText, "running");

    while (true) {
      if (Date.now() - startedAt > turn.budget.maxWallClockMs) {
        return stop("timeout", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
      }
      if (modelTurns >= turn.budget.maxModelTurns) {
        return stop("max_model_turns", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
      }
      if (toolCalls >= turn.budget.maxToolCalls) {
        return stop("max_tool_calls", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
      }
      if (turn.abortSignal?.aborted) {
        return stop("cancelled", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
      }

      const tools = this.deps.toolRouter.modelVisibleTools(turn as AgentLoopTurnContext<unknown>);
      if (modelTurns === 0) {
        await this.record(turn, {
          type: "turn_context",
          ...this.baseEvent(turn),
          cwd: turn.cwd,
          model: formatAgentLoopModelRef(turn.model),
          visibleTools: tools.map((tool) => tool.function.name),
        });
      }
      await this.record(turn, {
        type: "model_request",
        ...this.baseEvent(turn),
        model: formatAgentLoopModelRef(turn.model),
        toolCount: tools.length,
      });

      let protocol: AgentLoopModelTurnProtocol;
      try {
        protocol = await this.createTurnProtocol(turn, messages, tools);
      } catch (err) {
        if (turn.abortSignal?.aborted) {
          return stop("cancelled", startedAt, modelTurns, toolCalls, "Agent loop stopped: operator stop aborted active model work.", null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount, completionValidationAttempts, err instanceof Error ? err.message : String(err));
        }
        const failure = this.classifyRunFailure(err);
        return stop(
          failure.reason,
          startedAt,
          modelTurns,
          toolCalls,
          failure.message,
          null,
          false,
          compactions,
          await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot),
          toolResultSummaries,
          commandResults,
          messages,
          calledTools,
          lastToolLoopSignature,
          repeatedToolLoopCount,
          completionValidationAttempts,
          failure.detail,
        );
      }
      if (!protocol.responseCompleted) {
        return stop("protocol_incomplete", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
      }
      if (turn.abortSignal?.aborted) {
        return stop("cancelled", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
      }

      const response = this.protocolToResponse(protocol);
      modelTurns++;
      finalText = response.content;

      for (const assistant of protocol.assistant) {
        await this.record(turn, {
          type: "assistant_message",
          ...this.baseEvent(turn),
          phase: assistant.phase === "final_answer" ? "final_candidate" : "commentary",
          contentPreview: this.preview(assistant.content),
          toolCallCount: response.toolCalls.length,
        });
      }

      if (response.toolCalls.length === 0) {
        if (turn.finalOutputMode === "display_text") {
          if (response.content.trim().length === 0) {
            schemaRepairAttempts++;
            if (schemaRepairAttempts > turn.budget.maxSchemaRepairAttempts) {
              return stop("schema_error", startedAt, modelTurns, toolCalls, response.content, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
            }

            messages.push({ role: "assistant", content: response.content, phase: "final_answer" });
            messages.push({
              role: "user",
              content: "Your final answer was empty. Return a user-visible Markdown or plain text answer for the user.",
            });
            const compacted = await this.compactIfNeeded(turn, messages, "mid_turn", "context_limit", this.responseUsageTokens(protocol), compactions, compactionRecords);
            if (compacted.error) {
              return stop("fatal_error", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
            }
            messages = compacted.messages;
            compactionRecords = compacted.compactionRecords;
            compactions += compacted.compacted ? 1 : 0;
            await this.saveState(turn, messages, compactionRecords, modelTurns, toolCalls, compactions, completionValidationAttempts, calledTools, lastToolLoopSignature, repeatedToolLoopCount, finalText, "running");
            continue;
          }

          const missingRequiredTools = this.missingRequiredTools(turn, calledTools);
          if (missingRequiredTools.length > 0) {
            messages.push({ role: "assistant", content: response.content, phase: "final_answer" });
            messages.push({
              role: "user",
              content: `Before the final answer, call these required tool(s) at least once: ${missingRequiredTools.join(", ")}.`,
            });
            const compacted = await this.compactIfNeeded(turn, messages, "mid_turn", "context_limit", this.responseUsageTokens(protocol), compactions, compactionRecords);
            if (compacted.error) {
              return stop("fatal_error", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
            }
            messages = compacted.messages;
            compactionRecords = compacted.compactionRecords;
            compactions += compacted.compacted ? 1 : 0;
            await this.saveState(turn, messages, compactionRecords, modelTurns, toolCalls, compactions, completionValidationAttempts, calledTools, lastToolLoopSignature, repeatedToolLoopCount, finalText, "running");
            continue;
          }

          const changedFiles = await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot);
          await this.record(turn, {
            type: "final",
            ...this.baseEvent(turn),
            success: true,
            outputPreview: this.preview(response.content),
          });
          return stop("completed", startedAt, modelTurns, toolCalls, response.content, null, true, compactions, changedFiles, toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount, completionValidationAttempts);
        }

        const parsed = this.parseFinal(response.content, turn.outputSchema);
        if (parsed.success) {
          const missingRequiredTools = this.missingRequiredTools(turn, calledTools);
          if (missingRequiredTools.length > 0) {
            messages.push({ role: "assistant", content: response.content, phase: "final_answer" });
            messages.push({
              role: "user",
              content: `Before the final answer, call these required tool(s) at least once: ${missingRequiredTools.join(", ")}.`,
            });
            const compacted = await this.compactIfNeeded(turn, messages, "mid_turn", "context_limit", this.responseUsageTokens(protocol), compactions, compactionRecords);
            if (compacted.error) {
              return stop("fatal_error", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
            }
            messages = compacted.messages;
            compactionRecords = compacted.compactionRecords;
            compactions += compacted.compacted ? 1 : 0;
            await this.saveState(turn, messages, compactionRecords, modelTurns, toolCalls, compactions, completionValidationAttempts, calledTools, lastToolLoopSignature, repeatedToolLoopCount, finalText, "running");
            continue;
          }

          const changedFiles = await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot);
          const completionValidation = turn.completionValidator?.({
            output: parsed.output,
            changedFiles,
            commandResults,
            calledTools: [...calledTools],
            modelTurns,
            toolCalls,
          });
          if (completionValidation && !completionValidation.ok) {
            completionValidationAttempts++;
            if (completionValidationAttempts > turn.budget.maxCompletionValidationAttempts) {
              return stop("completion_gate_failed", startedAt, modelTurns, toolCalls, response.content, null, false, compactions, changedFiles, toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount, completionValidationAttempts);
            }

            messages.push({ role: "assistant", content: response.content, phase: "final_answer" });
            messages.push({
              role: "user",
              content: this.buildCompletionRepairPrompt(completionValidation.reasons),
            });
            const compacted = await this.compactIfNeeded(turn, messages, "mid_turn", "context_limit", this.responseUsageTokens(protocol), compactions, compactionRecords);
            if (compacted.error) {
              return stop("fatal_error", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, changedFiles, toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount, completionValidationAttempts);
            }
            messages = compacted.messages;
            compactionRecords = compacted.compactionRecords;
            compactions += compacted.compacted ? 1 : 0;
            await this.saveState(turn, messages, compactionRecords, modelTurns, toolCalls, compactions, completionValidationAttempts, calledTools, lastToolLoopSignature, repeatedToolLoopCount, finalText, "running");
            continue;
          }

          await this.record(turn, {
            type: "final",
            ...this.baseEvent(turn),
            success: true,
            outputPreview: this.preview(response.content),
          });
          return stop("completed", startedAt, modelTurns, toolCalls, response.content, parsed.output, true, compactions, changedFiles, toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount, completionValidationAttempts);
        }

        schemaRepairAttempts++;
        if (schemaRepairAttempts > turn.budget.maxSchemaRepairAttempts) {
          return stop("schema_error", startedAt, modelTurns, toolCalls, response.content, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
        }

        messages.push({ role: "assistant", content: response.content, phase: "final_answer" });
        messages.push({
          role: "user",
          content: `Your final answer did not match the required JSON schema. Return only valid JSON. Parse error: ${parsed.error}`,
        });
        const compacted = await this.compactIfNeeded(turn, messages, "mid_turn", "context_limit", this.responseUsageTokens(protocol), compactions, compactionRecords);
        if (compacted.error) {
          return stop("fatal_error", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
        }
        messages = compacted.messages;
        compactionRecords = compacted.compactionRecords;
        compactions += compacted.compacted ? 1 : 0;
        await this.saveState(turn, messages, compactionRecords, modelTurns, toolCalls, compactions, completionValidationAttempts, calledTools, lastToolLoopSignature, repeatedToolLoopCount, finalText, "running");
        continue;
      }

      messages.push({
        role: "assistant",
        content: response.content || `Calling ${response.toolCalls.map((call) => call.name).join(", ")}`,
        phase: "commentary",
        ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
      });

      const toolLoopSignature = JSON.stringify(
        response.toolCalls.map((call) => ({ name: call.name, input: call.input })),
      );
      if (toolLoopSignature === lastToolLoopSignature) repeatedToolLoopCount++;
      else {
        lastToolLoopSignature = toolLoopSignature;
        repeatedToolLoopCount = 1;
      }

      if (repeatedToolLoopCount > turn.budget.maxRepeatedToolCalls) {
        return stop("stalled_tool_loop", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
      }
      if (turn.abortSignal?.aborted) {
        return stop("cancelled", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
      }

      for (const call of response.toolCalls) {
        const activityCategory = this.deps.toolRouter.resolveTool(call.name)?.metadata.activityCategory;
        await this.record(turn, {
          type: "tool_call_started",
          ...this.baseEvent(turn),
          callId: call.id,
          toolName: call.name,
          inputPreview: this.preview(this.stringify(call.input)),
          ...(activityCategory ? { activityCategory } : {}),
        });
      }

      const { results: toolResults, timedOut: toolBatchTimedOut } = await this.executeToolBatchWithinBudget(response.toolCalls, turn, startedAt);
      for (const result of toolResults) {
        const sourceCall = response.toolCalls.find((call) => call.id === result.callId);
        const observation = this.createToolObservation(
          result,
          sourceCall,
          toolBatchTimedOut,
        );
        if (result.execution?.status !== "not_executed") {
          calledTools.add(result.toolName);
        }
        toolCalls++;
        if (result.success) consecutiveToolErrors = 0;
        else consecutiveToolErrors++;

        toolResultSummaries.push({
          toolName: result.toolName,
          success: result.success,
          ...(result.execution ? { execution: result.execution } : {}),
          outputSummary: this.preview(result.content),
          durationMs: result.durationMs,
        });

        messages.push({
          role: "tool",
          toolCallId: result.callId,
          toolName: result.toolName,
          content: result.content,
          observation,
        });

        await this.record(turn, {
          type: "tool_call_finished",
          ...this.baseEvent(turn),
          callId: result.callId,
          toolName: result.toolName,
          inputPreview: this.preview(this.stringify(response.toolCalls.find((call) => call.id === result.callId)?.input ?? {})),
          success: result.success,
          disposition: result.disposition,
          outputPreview: this.preview(result.content),
          durationMs: result.durationMs,
          ...(result.artifacts ? { artifacts: result.artifacts } : {}),
          ...(result.truncated ? { truncated: result.truncated } : {}),
          ...(result.activityCategory ? { activityCategory: result.activityCategory } : {}),
        });

        await this.record(turn, {
          type: "tool_observation",
          ...this.baseEvent(turn),
          observation,
        });

        if (result.disposition === "approval_denied") {
          await this.record(turn, {
            type: "approval",
            ...this.baseEvent(turn),
            toolName: result.toolName,
            status: "denied",
            reason: result.content,
          });
        }

        if (result.toolName === "update_plan" && result.contextModifier) {
          await this.record(turn, {
            type: "plan_update",
            ...this.baseEvent(turn),
            summary: this.preview(result.contextModifier),
          });
        }

        if (result.command && result.cwd) {
          const commandClassification = classifyAgentLoopCommandResult({
            toolName: result.toolName,
            command: result.command,
          });
          commandResults.push({
            toolName: result.toolName,
            command: result.command,
            cwd: result.cwd,
            success: result.success,
            ...(result.execution ? { execution: result.execution } : {}),
            category: commandClassification.category,
            evidenceEligible: commandClassification.evidenceEligible,
            outputSummary: this.preview(result.content),
            durationMs: result.durationMs,
          });
        }

        if (result.disposition === "fatal" || result.fatal) {
          return stop("fatal_error", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
        }
        if (result.disposition === "cancelled") {
          return stop(toolBatchTimedOut ? "timeout" : "cancelled", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
        }
        if (consecutiveToolErrors >= turn.budget.maxConsecutiveToolErrors) {
          return stop("consecutive_tool_errors", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
        }
      }

      const compacted = await this.compactIfNeeded(turn, messages, "mid_turn", "context_limit", this.responseUsageTokens(protocol), compactions, compactionRecords);
      if (compacted.error) {
        return stop("fatal_error", startedAt, modelTurns, toolCalls, finalText, null, false, compactions, await this.collectChangedFiles(turn.cwd, initialWorkspaceSnapshot), toolResultSummaries, commandResults, messages, calledTools, lastToolLoopSignature, repeatedToolLoopCount);
      }
      messages = compacted.messages;
      compactionRecords = compacted.compactionRecords;
      compactions += compacted.compacted ? 1 : 0;
      await this.saveState(turn, messages, compactionRecords, modelTurns, toolCalls, compactions, completionValidationAttempts, calledTools, lastToolLoopSignature, repeatedToolLoopCount, finalText, "running");
    }
  }

  private parseFinal<TOutput>(
    content: string,
    schema: z.ZodType<TOutput, z.ZodTypeDef, unknown>,
  ): { success: true; output: TOutput } | { success: false; error: string } {
    try {
      const json = this.extractJson(content);
      return { success: true, output: schema.parse(JSON.parse(json)) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private extractJson(content: string): string {
    const fence = content.match(/```json\s*([\s\S]*?)\s*```/);
    return fence?.[1] ?? content;
  }

  private async stop<TOutput>(
    turn: AgentLoopTurnContext<TOutput>,
    reason: AgentLoopStopReason,
    startedAt: number,
    modelTurns: number,
    toolCalls: number,
    finalText: string,
    output: TOutput | null,
    success = false,
    compactions = 0,
    changedFiles: string[] = [],
    toolResults: AgentLoopToolResultSummary[] = [],
    commandResults: AgentLoopCommandResult[] = [],
    messages?: AgentLoopMessage[],
    calledTools?: Set<string>,
    lastToolLoopSignature?: string | null,
    repeatedToolLoopCount?: number,
    completionValidationAttempts?: number,
    reasonDetail?: string,
    compactionRecords: readonly AgentLoopCompactionRecord[] = [],
  ): Promise<AgentLoopResult<TOutput>> {
    await this.saveState(
      turn,
      messages ?? turn.messages,
      compactionRecords,
      modelTurns,
      toolCalls,
      compactions,
      completionValidationAttempts ?? 0,
      calledTools ?? new Set<string>(),
      lastToolLoopSignature ?? null,
      repeatedToolLoopCount ?? 0,
      finalText,
      success ? "completed" : "failed",
      reason,
      reasonDetail,
    );

    await this.record(turn, {
      type: "stopped",
      ...this.baseEvent(turn),
      reason,
      ...(reasonDetail ? { reasonDetail } : {}),
    });

    return {
      success,
      output,
      finalText,
      stopReason: reason,
      elapsedMs: Date.now() - startedAt,
      modelTurns,
      toolCalls,
      compactions,
      filesChanged: changedFiles.length > 0,
      changedFiles,
      toolResults,
      commandResults,
      traceId: turn.session.traceId,
      sessionId: turn.session.sessionId,
      turnId: turn.turnId,
    };
  }

  private buildCompletionRepairPrompt(reasons: string[]): string {
    const bullets = reasons.map((reason) => `- ${reason}`).join("\n");
    return [
      "Your final answer is premature. Do not finish yet.",
      "Before returning the final JSON again, continue the task and gather stronger completion evidence.",
      bullets,
      "Use tools to verify the claimed result, then return fresh final JSON only when these gaps are resolved.",
    ].join("\n");
  }

  private baseEvent<TOutput>(turn: AgentLoopTurnContext<TOutput>) {
    return {
      eventId: randomUUID(),
      sessionId: turn.session.sessionId,
      traceId: turn.session.traceId,
      turnId: turn.turnId,
      goalId: turn.goalId,
      ...(turn.taskId ? { taskId: turn.taskId } : {}),
      createdAt: new Date().toISOString(),
    };
  }

  private async record<TOutput>(turn: AgentLoopTurnContext<TOutput>, event: Parameters<typeof turn.session.traceStore.append>[0]): Promise<void> {
    await turn.session.traceStore.append(event);
    await turn.session.eventSink.emit(event);
  }

  private preview(value: string): string {
    return value.length > 500 ? `${value.slice(0, 500)}...` : value;
  }

  private stringify(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === undefined) return "";
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private classifyRunFailure(error: unknown): { reason: AgentLoopStopReason; detail: string; message: string } {
    const detail = error instanceof Error
      ? [error.name !== "Error" ? error.name : null, error.message]
        .filter((part): part is string => typeof part === "string" && part.length > 0)
        .join(": ")
      : String(error);
    const lowered = detail.toLowerCase();
    if (
      lowered.includes("timeout")
      || lowered.includes("timed out")
      || lowered.includes("aborterror")
      || lowered.includes("aborted")
    ) {
      return {
        reason: "timeout",
        detail,
        message: "Agent loop stopped: model request timed out. Narrow broad repo-wide searches or increase `codex_timeout_ms` if this workload is expected.",
      };
    }

    return {
      reason: "fatal_error",
      detail,
      message: `Agent loop stopped: model request failed. ${detail ? `Detail: ${detail}. ` : ""}Retry the turn or inspect the provider connection.`,
    };
  }

  private async compactIfNeeded<TOutput>(
    turn: AgentLoopTurnContext<TOutput>,
    messages: AgentLoopMessage[],
    phase: AgentLoopCompactionPhase,
    reason: AgentLoopCompactionReason,
    usageTokens: number | undefined,
    compactions: number,
    compactionRecords: readonly AgentLoopCompactionRecord[],
  ): Promise<{ messages: AgentLoopMessage[]; compactionRecords: AgentLoopCompactionRecord[]; compacted: boolean; error?: string }> {
    const limit = this.autoCompactLimit(turn);
    if (!limit || compactions >= turn.budget.maxCompactions) {
      return { messages, compactionRecords: cloneAgentLoopCompactionRecords(compactionRecords), compacted: false };
    }

    const tokens = usageTokens && usageTokens > 0 ? usageTokens : this.estimateTokens(messages);
    if (tokens < limit) {
      return { messages, compactionRecords: cloneAgentLoopCompactionRecords(compactionRecords), compacted: false };
    }

    try {
      const result = await this.compactor.compact({
        history: createAgentLoopHistory(messages, compactionRecords),
        maxMessages: turn.budget.compactionMaxMessages,
        phase,
        reason,
      });
      if (!result.compacted) {
        return {
          messages: result.history.messages,
          compactionRecords: cloneAgentLoopCompactionRecords(result.history.compactionRecords),
          compacted: false,
        };
      }
      await this.record(turn, {
        type: "context_compaction",
        ...this.baseEvent(turn),
        phase,
        reason,
        inputMessages: messages.length,
        outputMessages: result.history.messages.length,
        summaryPreview: this.preview(result.summary ?? ""),
      });
      return {
        messages: result.history.messages,
        compactionRecords: cloneAgentLoopCompactionRecords(result.history.compactionRecords),
        compacted: true,
      };
    } catch (err) {
      return {
        messages,
        compactionRecords: cloneAgentLoopCompactionRecords(compactionRecords),
        compacted: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private autoCompactLimit<TOutput>(turn: AgentLoopTurnContext<TOutput>): number | undefined {
    if (turn.budget.autoCompactTokenLimit && turn.budget.autoCompactTokenLimit > 0) {
      return turn.budget.autoCompactTokenLimit;
    }
    const contextLimit = turn.modelInfo.capabilities.contextLimitTokens;
    return contextLimit && contextLimit > 0 ? Math.floor(contextLimit * 0.9) : undefined;
  }

  private async executeToolBatchWithinBudget<TOutput>(
    calls: Parameters<AgentLoopToolRuntime["executeBatch"]>[0],
    turn: AgentLoopTurnContext<TOutput>,
    startedAt: number,
  ): Promise<{ results: Awaited<ReturnType<AgentLoopToolRuntime["executeBatch"]>>; timedOut: boolean }> {
    const remainingMs = Math.max(1, turn.budget.maxWallClockMs - (Date.now() - startedAt));
    const controller = new AbortController();
    const parentSignal = turn.abortSignal;
    let timedOut = false;
    const abortFromParent = () => controller.abort();
    if (parentSignal?.aborted) {
      controller.abort();
    } else {
      parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, remainingMs);
    const timeoutMs = Math.min(turn.toolCallContext.timeoutMs ?? remainingMs, remainingMs);
    const boundedTurn = {
      ...turn,
      abortSignal: controller.signal,
      toolCallContext: {
        ...turn.toolCallContext,
        abortSignal: controller.signal,
        timeoutMs,
      },
    } as AgentLoopTurnContext<unknown>;

    try {
      return { results: await this.deps.toolRuntime.executeBatch(calls, boundedTurn), timedOut };
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  }

  private responseUsageTokens(response: { usage?: { inputTokens: number; outputTokens: number } }): number | undefined {
    if (!response.usage) return undefined;
    return response.usage.inputTokens + response.usage.outputTokens;
  }

  private estimateTokens(messages: AgentLoopMessage[]): number {
    const chars = messages.reduce((total, message) => total + message.content.length, 0);
    return Math.ceil(chars / 4);
  }

  private missingRequiredTools<TOutput>(
    turn: AgentLoopTurnContext<TOutput>,
    calledTools: Set<string>,
  ): string[] {
    return [...(turn.toolPolicy.requiredTools ?? [])].filter((toolName) => !calledTools.has(toolName));
  }

  private createToolObservation(
    result: Awaited<ReturnType<AgentLoopToolRuntime["executeBatch"]>>[number],
    sourceCall: AgentLoopToolCall | undefined,
    toolBatchTimedOut: boolean,
  ): AgentLoopToolObservation;
  private createToolObservation(
    result: Awaited<ReturnType<AgentLoopToolRuntime["executeBatch"]>>[number],
    sourceCall: AgentLoopToolCall | undefined,
    toolBatchTimedOut: boolean,
  ): AgentLoopToolObservation {
    const state = this.toolObservationState(result, toolBatchTimedOut);
    const execution = this.toolObservationExecution(result, state);
    const rawResult = result.rawResult;
    return {
      type: "tool_observation",
      callId: result.callId,
      toolName: result.toolName,
      arguments: sourceCall?.input ?? {},
      state,
      success: result.success,
      execution,
      durationMs: result.durationMs,
      output: {
        content: result.content,
        ...(rawResult?.summary ? { summary: rawResult.summary } : {}),
        ...(rawResult && Object.prototype.hasOwnProperty.call(rawResult, "data") ? { data: rawResult.data } : {}),
        ...(rawResult?.error ? { error: rawResult.error } : {}),
      },
      ...(result.command ? { command: result.command } : {}),
      ...(result.cwd ? { cwd: result.cwd } : {}),
      ...(result.artifacts ? { artifacts: result.artifacts } : {}),
      ...(result.truncated ? { truncated: result.truncated } : {}),
      ...(result.activityCategory ? { activityCategory: result.activityCategory } : {}),
    };
  }

  private toolObservationState(
    result: Awaited<ReturnType<AgentLoopToolRuntime["executeBatch"]>>[number],
    toolBatchTimedOut: boolean,
  ): AgentLoopToolObservationState {
    const reason = result.execution?.reason;
    if (reason === "timed_out" || (toolBatchTimedOut && result.disposition === "cancelled")) return "timed_out";
    if (reason === "interrupted" || result.disposition === "cancelled") return "interrupted";
    if (reason === "approval_denied" || reason === "permission_denied") return "denied";
    if (reason === "policy_blocked" || reason === "dry_run") return "blocked";
    return result.success ? "success" : "failure";
  }

  private toolObservationExecution(
    result: Awaited<ReturnType<AgentLoopToolRuntime["executeBatch"]>>[number],
    state: AgentLoopToolObservationState,
  ): AgentLoopToolObservationExecution {
    if (result.execution) return result.execution;
    if (state === "timed_out" || state === "interrupted") {
      return {
        status: "executed",
        reason: state === "timed_out" ? "timed_out" : "interrupted",
        message: result.content,
      };
    }
    return { status: "executed" };
  }

  private async createTurnProtocol<TOutput>(
    turn: AgentLoopTurnContext<TOutput>,
    messages: AgentLoopMessage[],
    tools: ReturnType<AgentLoopToolRouter["modelVisibleTools"]>,
  ): Promise<AgentLoopModelTurnProtocol> {
    if (this.deps.modelClient.createTurnProtocol) {
      return this.deps.modelClient.createTurnProtocol({
        model: turn.model,
        messages,
        tools,
        abortSignal: turn.abortSignal,
      });
    }

    const response = await this.deps.modelClient.createTurn({
      model: turn.model,
      messages,
      tools,
      abortSignal: turn.abortSignal,
    });
    return {
      assistant: response.content || response.toolCalls.length > 0 ? [{
        content: response.content || `Calling ${response.toolCalls.map((call) => call.name).join(", ")}`,
        phase: response.toolCalls.length > 0 ? "commentary" : "final_answer",
      }] : [],
      toolCalls: response.toolCalls,
      responseItems: [
        ...(response.content || response.toolCalls.length > 0
          ? [assistantTextResponseItem(
              response.content || `Calling ${response.toolCalls.map((call) => call.name).join(", ")}`,
              response.toolCalls.length > 0 ? "commentary" : "final_answer",
            )]
          : []),
        ...response.toolCalls.map((call) => functionToolCallResponseItem(call)),
      ],
      stopReason: response.stopReason,
      responseCompleted: true,
      usage: response.usage,
    };
  }

  private protocolToResponse(protocol: AgentLoopModelTurnProtocol): { content: string; toolCalls: AgentLoopModelTurnProtocol["toolCalls"] } {
    const responseItemText = protocol.responseItems
      ?.filter((item) => item.type === "assistant_text")
      .map((item) => item.content)
      .filter(Boolean)
      .join("\n");
    const responseItemToolCalls = protocol.responseItems
      ?.filter((item): item is FunctionToolCallResponseItem => item.type === "function_tool_call")
      .map((item) => ({
        id: item.id,
        name: item.name,
        input: item.arguments,
      }));
    return {
      content: protocol.assistant.map((item) => item.content).filter(Boolean).join("\n") || responseItemText || "",
      toolCalls: protocol.responseItems ? responseItemToolCalls ?? [] : protocol.toolCalls,
    };
  }

  private async saveState<TOutput>(
    turn: AgentLoopTurnContext<TOutput>,
    messages: AgentLoopMessage[],
    compactionRecords: readonly AgentLoopCompactionRecord[],
    modelTurns: number,
    toolCalls: number,
    compactions: number,
    completionValidationAttempts: number,
    calledTools: Set<string>,
    lastToolLoopSignature: string | null,
    repeatedToolLoopCount: number,
    finalText: string,
    status: AgentLoopSessionState["status"],
    stopReason?: AgentLoopStopReason,
    stopDetail?: string,
  ): Promise<void> {
    const state: AgentLoopSessionState = {
      sessionId: turn.session.sessionId,
      traceId: turn.session.traceId,
      turnId: turn.turnId,
      goalId: turn.goalId,
      ...(turn.taskId ? { taskId: turn.taskId } : {}),
      cwd: turn.cwd,
      modelRef: formatAgentLoopModelRef(turn.model),
      messages,
      compactionRecords: cloneAgentLoopCompactionRecords(compactionRecords),
      modelTurns,
      toolCalls,
      compactions,
      completionValidationAttempts,
      calledTools: [...calledTools],
      lastToolLoopSignature,
      repeatedToolLoopCount,
      finalText,
      status,
      ...(stopReason ? { stopReason } : {}),
      ...(stopDetail ? { stopDetail } : {}),
      updatedAt: new Date().toISOString(),
    };
    await turn.session.stateStore.save(state);
  }

  private async captureWorkspaceSnapshot(cwd: string): Promise<WorkspaceSnapshot | null> {
    const result = await execFileNoThrow("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, timeoutMs: 10_000 });
    if ((result.exitCode ?? 1) === 0) {
      return { kind: "git", paths: new Set(this.parseGitStatusPaths(result.stdout)) };
    }
    return { kind: "filesystem", files: await this.captureFilesystemSnapshot(cwd) };
  }

  private async collectChangedFiles(cwd: string, before: WorkspaceSnapshot | null): Promise<string[]> {
    const afterResult = await execFileNoThrow("git", ["status", "--porcelain", "--untracked-files=all"], { cwd, timeoutMs: 10_000 });
    if ((afterResult.exitCode ?? 1) !== 0) {
      if (before?.kind !== "filesystem") return [];
      return this.collectFilesystemChangedPaths(before.files, await this.captureFilesystemSnapshot(cwd));
    }
    const after = new Set(this.parseGitStatusPaths(afterResult.stdout));
    if (!before || before.kind !== "git") return [...after];
    return [...after].filter((file) => !before.paths.has(file));
  }

  private parseGitStatusPaths(stdout: string): string[] {
    return stdout
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length >= 4)
      .map((line) => line.slice(3).trim())
      .map((filePath) => filePath.includes(" -> ") ? filePath.split(" -> ").at(-1) ?? filePath : filePath);
  }

  private async captureFilesystemSnapshot(cwd: string): Promise<Map<string, FilesystemSnapshotEntry>> {
    const files = new Map<string, FilesystemSnapshotEntry>();
    const root = path.resolve(cwd);
    const visit = async (dir: string): Promise<void> => {
      if (files.size >= FILESYSTEM_SNAPSHOT_MAX_FILES) return;
      let entries: Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.size >= FILESYSTEM_SNAPSHOT_MAX_FILES) return;
        if (entry.name.startsWith(".pulseed-")) continue;
        const absolutePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!FILESYSTEM_SNAPSHOT_EXCLUDED_DIRS.has(entry.name)) {
            await visit(absolutePath);
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const relativePath = path.relative(root, absolutePath).replace(/\\/g, "/");
        try {
          const stat = await fsp.stat(absolutePath);
          const snapshotEntry: FilesystemSnapshotEntry = {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          };
          if (stat.size <= FILESYSTEM_SNAPSHOT_HASH_MAX_BYTES) {
            snapshotEntry.hash = createHash("sha256")
              .update(await fsp.readFile(absolutePath))
              .digest("hex");
          }
          files.set(relativePath, snapshotEntry);
        } catch {
          // File may have changed while scanning; skip and let the next scan observe it.
        }
      }
    };
    await visit(root);
    return files;
  }

  private collectFilesystemChangedPaths(
    before: Map<string, FilesystemSnapshotEntry>,
    after: Map<string, FilesystemSnapshotEntry>,
  ): string[] {
    const changed = new Set<string>();
    for (const [filePath, afterEntry] of after) {
      const beforeEntry = before.get(filePath);
      if (!beforeEntry || !this.sameFilesystemEntry(beforeEntry, afterEntry)) {
        changed.add(filePath);
      }
    }
    for (const filePath of before.keys()) {
      if (!after.has(filePath)) {
        changed.add(filePath);
      }
    }
    return [...changed].sort();
  }

  private sameFilesystemEntry(left: FilesystemSnapshotEntry, right: FilesystemSnapshotEntry): boolean {
    if (left.hash && right.hash) return left.hash === right.hash;
    return left.size === right.size && left.mtimeMs === right.mtimeMs;
  }
}
