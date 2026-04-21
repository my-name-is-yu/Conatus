import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { StateManager } from "../../../base/state/state-manager.js";
import { SessionManager } from "../session-manager.js";
import { runLLMReview } from "../task/task-verifier-llm.js";
import type { VerifierDeps } from "../task/task-verifier-types.js";
import type { Task } from "../../../base/types/task.js";
import type { AgentResult } from "../adapter-layer.js";
import type { IPromptGateway } from "../../../prompt/gateway.js";
import type { PromptGatewayInput, PromptGatewayExecutionResult } from "../../../prompt/gateway.js";

function makeTask(): Task {
  return {
    id: "task-gateway-usage",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["coverage"],
    primary_dimension: "coverage",
    work_description: "write tests",
    rationale: "increase coverage",
    approach: "add unit tests",
    success_criteria: [
      {
        description: "tests pass",
        verification_method: "run tests",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["tests/"],
      out_of_scope: ["src/"],
      blast_radius: "low",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "running",
    started_at: new Date().toISOString(),
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
  };
}

function makeExecutionResult(): AgentResult {
  return {
    success: true,
    output: "done",
    error: null,
    exit_code: 0,
    elapsed_ms: 10,
    stopped_reason: "completed",
  };
}

describe("runLLMReview gateway usage telemetry", () => {
  it("records gateway usage tokens and updates the verifier accumulator", async () => {
    const tmpDir = makeTempDir("pulseed-task-verifier-gateway-usage-");
    const stateManager = new StateManager(tmpDir);
    const sessionManager = new SessionManager(stateManager);
    const tokenAccumulator = { tokensUsed: 0 };
    const gateway: IPromptGateway = {
      async execute<T>(_input: PromptGatewayInput<T>): Promise<T> {
        return {
          verdict: "pass",
          reasoning: "done",
          criteria_met: 1,
          criteria_total: 1,
        } as T;
      },
      async executeWithUsage<T>(_input: PromptGatewayInput<T>): Promise<PromptGatewayExecutionResult<T>> {
        return {
          data: {
            verdict: "pass",
            reasoning: "done",
            criteria_met: 1,
            criteria_total: 1,
          } as T,
          usage: {
            inputTokens: 30,
            outputTokens: 12,
            totalTokens: 42,
          },
          contextTokens: 77,
        };
      },
    };
    const deps = {
      stateManager,
      llmClient: {
        async sendMessage() {
          throw new Error("not used");
        },
        parseJSON() {
          throw new Error("not used");
        },
      },
      sessionManager,
      trustManager: ({ getBalance: async () => ({ balance: 0 }) } as unknown as VerifierDeps["trustManager"]),
      stallDetector: ({ detectStall: async () => null } as unknown as VerifierDeps["stallDetector"]),
      gateway,
      _tokenAccumulator: tokenAccumulator,
    } as unknown as VerifierDeps;

    try {
      const review = await runLLMReview(
        deps,
        makeTask(),
        makeExecutionResult(),
      );

      expect(review.passed).toBe(true);
      expect(review.tokensUsed).toBe(42);
      expect(tokenAccumulator.tokensUsed).toBe(42);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});
