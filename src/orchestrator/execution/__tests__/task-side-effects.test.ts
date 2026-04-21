import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { persistTaskCycleSideEffects } from "../task/task-side-effects.js";
import type { Task, VerificationResult } from "../../../base/types/task.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { AgentResult, IAdapter } from "../adapter-layer.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { loadDreamPlaybooks, upsertDreamPlaybook } from "../../../platform/dream/playbook-memory.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["dim"],
    primary_dimension: "dim",
    work_description: "test task",
    rationale: "test rationale",
    approach: "test approach",
    success_criteria: [
      {
        description: "Tests pass",
        verification_method: "npx vitest run",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["module A"],
      out_of_scope: ["module B"],
      blast_radius: "low",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 2, unit: "hours" },
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("persistTaskCycleSideEffects", () => {
  it("saves the final verdict action in the checkpoint snapshot", async () => {
    const tmpDir = makeTempDir("task-side-effects-");
    const stateManager = new StateManager(tmpDir);
    const saveCheckpoint = vi.fn().mockResolvedValue(undefined);
    const sessionManager = { saveCheckpoint } as unknown as {
      saveCheckpoint: typeof saveCheckpoint;
    };
    const task = makeTask({ strategy_id: "strategy-1" });
    const verificationResult: VerificationResult = {
      timestamp: new Date().toISOString(),
      task_id: task.id,
      verdict: "pass",
      confidence: 0.9,
      evidence: [],
      dimension_updates: [],
    };
    const executionResult: AgentResult = {
      success: true,
      output: "Task completed successfully",
      error: null,
      exit_code: 0,
      elapsed_ms: 100,
      stopped_reason: "completed",
    };
    const adapter = { adapterType: "mock" } as IAdapter;

    await persistTaskCycleSideEffects({
      goalId: "goal-1",
      targetDimension: "dim",
      task,
      action: "completed",
      verificationResult,
      executionResult,
      adapter,
      stateManager,
      sessionManager: sessionManager as never,
      llmClient: {} as never,
      gapValue: 0.4,
    });

    expect(saveCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionContextSnapshot: expect.stringContaining("action: completed"),
      })
    );
    expect(saveCheckpoint).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionContextSnapshot: expect.stringContaining("action: pass"),
      })
    );
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("captures a promoted playbook for verifier-backed passing tasks without touching skills", async () => {
    const tmpDir = makeTempDir("task-side-effects-playbooks-");
    const stateManager = new StateManager(tmpDir);
    fs.mkdirSync(`${tmpDir}/skills/manual/example`, { recursive: true });
    fs.writeFileSync(`${tmpDir}/skills/manual/example/SKILL.md`, "# Existing Skill\n");

    const saveCheckpoint = vi.fn().mockResolvedValue(undefined);
    const sessionManager = { saveCheckpoint } as unknown as {
      saveCheckpoint: typeof saveCheckpoint;
    };
    const task = makeTask({
      id: "task-promoted",
      work_description: "Repair the provider config type boundary",
      approach: "Patch the provider config boundary and rerun focused verification",
      constraints: ["Do not widen runtime acceptance"],
    });
    const verificationResult: VerificationResult = {
      timestamp: new Date().toISOString(),
      task_id: task.id,
      verdict: "pass",
      confidence: 0.88,
      evidence: [
        {
          layer: "mechanical",
          description: "Focused typecheck passed after the boundary fix",
          confidence: 0.92,
        },
      ],
      dimension_updates: [],
    };
    const executionResult: AgentResult = {
      success: true,
      output: "Focused verification passed",
      error: null,
      exit_code: 0,
      elapsed_ms: 120,
      stopped_reason: "completed",
    };
    const adapter = { adapterType: "mock" } as IAdapter;

    await persistTaskCycleSideEffects({
      goalId: "goal-1",
      targetDimension: "type_safety",
      task,
      action: "completed",
      verificationResult,
      executionResult,
      adapter,
      stateManager,
      sessionManager: sessionManager as never,
      llmClient: {} as never,
      gapValue: 0.3,
    });

    const playbooks = await loadDreamPlaybooks(tmpDir);
    expect(playbooks).toHaveLength(1);
    expect(playbooks[0]).toMatchObject({
      status: "promoted",
      title: "Repair the provider config type boundary",
      applicability: expect.objectContaining({
        primary_dimensions: ["dim"],
        task_categories: ["normal"],
      }),
      usage: expect.objectContaining({
        verified_success_count: 1,
      }),
    });
    expect(fs.readFileSync(`${tmpDir}/skills/manual/example/SKILL.md`, "utf8")).toBe("# Existing Skill\n");
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("records failed reuse outcomes for referenced playbooks", async () => {
    const tmpDir = makeTempDir("task-side-effects-reuse-");
    const stateManager = new StateManager(tmpDir);
    const now = new Date().toISOString();
    await upsertDreamPlaybook(stateManager.getBaseDir(), {
      playbook_id: "dream-playbook-reuse",
      status: "promoted",
      kind: "verified_execution",
      title: "Provider config boundary fix",
      summary: "Verified workflow",
      source_signature: "provider-config-boundary",
      applicability: {
        goal_ids: ["goal-1"],
        primary_dimensions: ["type_safety"],
        task_categories: ["verification"],
        terms: ["provider", "config"],
      },
      preconditions: [],
      recommended_steps: ["Patch the boundary"],
      verification_checks: [],
      failure_warnings: [],
      evidence_refs: [],
      source_task_ids: ["task-seed"],
      verification: { verdict: "pass", confidence: 0.9, last_verified_at: now },
      usage: {
        retrieved_count: 0,
        verified_success_count: 1,
        successful_reuse_count: 0,
        failed_reuse_count: 0,
      },
      governance: {
        created_by: "dream",
        review_state: "verified",
        auto_generated: true,
        user_editable: true,
        auto_mutation: "forbidden",
      },
      created_at: now,
      updated_at: now,
    });

    const saveCheckpoint = vi.fn().mockResolvedValue(undefined);
    const sessionManager = { saveCheckpoint } as unknown as {
      saveCheckpoint: typeof saveCheckpoint;
    };
    const task = makeTask({ id: "task-failed-reuse" });
    const verificationResult: VerificationResult = {
      timestamp: new Date().toISOString(),
      task_id: task.id,
      verdict: "fail",
      confidence: 0.3,
      evidence: [
        {
          layer: "mechanical",
          description: "Focused verification still fails",
          confidence: 0.8,
        },
      ],
      dimension_updates: [],
    };
    const executionResult: AgentResult = {
      success: false,
      output: "Verification failed",
      error: "failed",
      exit_code: 1,
      elapsed_ms: 150,
      stopped_reason: "error",
    };
    const adapter = { adapterType: "mock" } as IAdapter;

    await persistTaskCycleSideEffects({
      goalId: "goal-1",
      targetDimension: "type_safety",
      task,
      action: "discard",
      verificationResult,
      executionResult,
      adapter,
      stateManager,
      sessionManager: sessionManager as never,
      llmClient: {} as never,
      reusedPlaybookIds: ["dream-playbook-reuse"],
      gapValue: 0.5,
    });

    const [playbook] = await loadDreamPlaybooks(tmpDir);
    expect(playbook).toMatchObject({
      usage: expect.objectContaining({
        retrieved_count: 1,
        failed_reuse_count: 1,
      }),
    });
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
});
