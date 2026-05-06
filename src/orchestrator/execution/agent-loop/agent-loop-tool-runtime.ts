import type { ToolExecutor } from "../../../tools/executor.js";
import type { AgentLoopToolCall } from "./agent-loop-model.js";
import type { AgentLoopToolOutput } from "./agent-loop-tool-output.js";
import type { AgentLoopToolRouter } from "./agent-loop-tool-router.js";
import type { AgentLoopTurnContext } from "./agent-loop-turn-context.js";
import { ResponseItemToolRouter } from "./response-item-tool-router.js";
import { functionToolCallResponseItem } from "./response-item.js";
import type { ToolObservationResponseItem } from "./response-item.js";

export interface AgentLoopToolRuntime {
  executeBatch(
    calls: AgentLoopToolCall[],
    turn: AgentLoopTurnContext<unknown>
  ): Promise<AgentLoopToolOutput[]>;
}

export class ToolExecutorAgentLoopToolRuntime implements AgentLoopToolRuntime {
  private readonly responseItemToolRouter: ResponseItemToolRouter;

  constructor(
    private readonly executor: ToolExecutor,
    private readonly router: AgentLoopToolRouter,
  ) {
    this.responseItemToolRouter = new ResponseItemToolRouter({
      executor: this.executor,
      toolRouter: this.router,
    });
  }

  async executeBatch(
    calls: AgentLoopToolCall[],
    turn: AgentLoopTurnContext<unknown>
  ): Promise<AgentLoopToolOutput[]> {
    const observations = await this.responseItemToolRouter.executeBatch(
      calls.map((call) => functionToolCallResponseItem(call)),
      turn,
    );
    const outputs = observations.map((observation) =>
      this.outputFromObservation(observation, turn)
    );
    for (const output of outputs) {
      this.activateToolSearchResults(turn, output);
    }
    return outputs;
  }

  private outputFromObservation(
    observation: ToolObservationResponseItem,
    turn: AgentLoopTurnContext<unknown>,
  ): AgentLoopToolOutput {
    if (observation.type === "unknown_tool") {
      return {
        callId: observation.callId,
        toolName: observation.toolName,
        success: false,
        content: `UNKNOWN TOOL: ${observation.message}`,
        durationMs: observation.durationMs,
        disposition: "respond_to_model",
        execution: observation.execution,
      };
    }

    if (observation.type === "tool_error") {
      const result = observation.result;
      const execution = observation.execution ?? result?.execution ?? {
        status: "not_executed" as const,
        reason: "tool_error" as const,
        message: observation.error.message,
      };
      const command = this.extractCommand(observation.toolName, observation.arguments);
      const resolvedCwd = this.extractCwd(observation.arguments) ?? turn.cwd;
      const activityCategory = this.router.resolveTool(observation.toolName)?.metadata.activityCategory;
      return {
        callId: observation.callId,
        toolName: observation.toolName,
        success: false,
        content: result
          ? this.formatContent(result, execution)
          : this.formatToolErrorContent(observation, execution),
        durationMs: observation.durationMs,
        disposition: this.resolveDisposition(result?.error ?? observation.error.message, turn.abortSignal?.aborted === true),
        execution,
        ...(result ? { rawResult: result } : {}),
        ...(command ? { command, cwd: resolvedCwd } : {}),
        ...(activityCategory ? { activityCategory } : {}),
        ...(result?.artifacts ? { artifacts: result.artifacts } : {}),
        ...(result?.truncated ? { truncated: result.truncated } : {}),
      };
    }

    const result = observation.result;
    const disposition = this.resolveDisposition(result.error, turn.abortSignal?.aborted === true);
    const execution = result.execution ?? (disposition === "approval_denied"
      ? { status: "not_executed" as const, reason: "approval_denied" as const, message: result.error ?? result.summary }
      : { status: "executed" as const });
    const command = this.extractCommand(observation.toolName, observation.arguments);
    const resolvedCwd = this.extractCwd(observation.arguments) ?? turn.cwd;
    const activityCategory = this.router.resolveTool(observation.toolName)?.metadata.activityCategory;
    return {
      callId: observation.callId,
      toolName: observation.toolName,
      success: result.success,
      content: this.formatContent(result, execution),
      durationMs: observation.durationMs,
      disposition,
      execution,
      ...(result.contextModifier ? { contextModifier: result.contextModifier } : {}),
      rawResult: result,
      ...(command ? { command, cwd: resolvedCwd } : {}),
      ...(activityCategory ? { activityCategory } : {}),
      ...(result.artifacts ? { artifacts: result.artifacts } : {}),
      ...(result.truncated ? { truncated: result.truncated } : {}),
    };
  }

  private stringify(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === undefined) return "";
    return JSON.stringify(value);
  }

  private formatContent(result: Awaited<ReturnType<ToolExecutor["execute"]>>, execution: NonNullable<AgentLoopToolOutput["execution"]>): string {
    if (execution.status === "not_executed") {
      const reason = execution.reason ? ` (${execution.reason})` : "";
      const message = execution.message ?? result.error ?? result.summary;
      return `TOOL NOT EXECUTED${reason}: ${message}`;
    }
    return result.success
      ? `${result.summary}\n${this.stringify(result.data)}${result.contextModifier ? `\n${result.contextModifier}` : ""}`
      : result.error ?? result.summary;
  }

  private formatToolErrorContent(
    observation: Extract<ToolObservationResponseItem, { type: "tool_error" }>,
    execution: NonNullable<AgentLoopToolOutput["execution"]>,
  ): string {
    if (execution.status === "not_executed") {
      const reason = execution.reason ? ` (${execution.reason})` : "";
      return `TOOL NOT EXECUTED${reason}: ${observation.error.message}`;
    }
    return observation.error.message;
  }

  private resolveDisposition(
    error: string | undefined,
    aborted: boolean,
  ): AgentLoopToolOutput["disposition"] {
    if (aborted) return "cancelled";
    if (!error) return "respond_to_model";
    if (error.startsWith("User denied approval")) return "approval_denied";
    return "respond_to_model";
  }

  private extractCommand(toolName: string, input: unknown): string | undefined {
    if (!input || typeof input !== "object") return undefined;
    const obj = input as Record<string, unknown>;
    if (typeof obj["command"] === "string") return obj["command"];
    if (toolName === "grep" && typeof obj["pattern"] === "string") {
      const target = typeof obj["glob"] === "string"
        ? obj["glob"]
        : typeof obj["path"] === "string"
          ? obj["path"]
          : ".";
      return `grep ${obj["pattern"]} ${target}`;
    }
    return undefined;
  }

  private extractCwd(input: unknown): string | undefined {
    return input && typeof input === "object" && typeof (input as Record<string, unknown>)["cwd"] === "string"
      ? (input as Record<string, string>)["cwd"]
      : undefined;
  }

  private activateToolSearchResults(
    turn: AgentLoopTurnContext<unknown>,
    output: AgentLoopToolOutput,
  ): void {
    if (output.toolName !== "tool_search" || !output.success) return;
    const data = output.rawResult && typeof output.rawResult === "object"
      ? (output.rawResult as Record<string, unknown>)["data"]
      : undefined;
    const results = Array.isArray(data) ? data : this.parseToolSearchContent(output.content);
    if (!results || results.length === 0) return;

    turn.toolPolicy.activatedTools ??= new Set<string>();
    for (const item of results) {
      if (item && typeof item === "object" && typeof (item as Record<string, unknown>)["name"] === "string") {
        turn.toolPolicy.activatedTools.add((item as Record<string, unknown>)["name"] as string);
      }
    }
  }

  private parseToolSearchContent(content: string): unknown[] | null {
    const firstArray = content.indexOf("[");
    if (firstArray < 0) return null;
    try {
      const parsed = JSON.parse(content.slice(firstArray)) as unknown;
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}
