import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Task } from "../../../../base/types/task.js";
import {
  buildTaskAgentLoopTurnContext,
  createAgentLoopSession,
  defaultAgentLoopCapabilities,
  type AgentLoopModelInfo,
} from "../index.js";

function makeModelInfo(): AgentLoopModelInfo {
  return {
    ref: { providerId: "test", modelId: "model" },
    displayName: "test/model",
    capabilities: { ...defaultAgentLoopCapabilities },
  };
}

function makeKaggleArtifactTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["score"],
    primary_dimension: "score",
    work_description: "Run Kaggle training and produce metrics plus submission artifacts",
    rationale: "Fresh artifacts are required to prove score progress.",
    approach: "Run the local experiment and write reports/metrics plus submissions.",
    success_criteria: [
      {
        description: "Training script exists",
        verification_method: "test -f src/experiments/train_hgb_engineered_auc.py",
        is_blocking: true,
      },
    ],
    scope_boundary: { in_scope: ["."], out_of_scope: [], blast_radius: "low" },
    constraints: [],
    artifact_contract: {
      required: true,
      required_artifacts: [
        {
          kind: "metrics_json",
          path: "reports/hgb_seed_blend.json",
          required_fields: ["balanced_accuracy"],
          fresh_after_task_start: true,
        },
        {
          kind: "submission_csv",
          path: "submissions/hgb_seed_blend.csv",
          required_fields: [],
          fresh_after_task_start: true,
        },
      ],
    },
    plateau_until: null,
    estimated_duration: { value: 1, unit: "hours" },
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

describe("task agent loop artifact contract completion gate", () => {
  it("rejects done when required metrics and submission artifacts are missing", async () => {
    const modelInfo = makeModelInfo();
    const turn = buildTaskAgentLoopTurnContext({
      task: makeKaggleArtifactTask(),
      model: modelInfo.ref,
      modelInfo,
      session: createAgentLoopSession(),
      cwd: process.cwd(),
    });

    const result = await turn.completionValidator!({
      output: {
        status: "done",
        finalAnswer: "Implemented the training script.",
        summary: "script only",
        filesChanged: ["src/experiments/train_hgb_engineered_auc.py"],
        testsRun: [{ command: "test -f src/experiments/train_hgb_engineered_auc.py", passed: true, outputSummary: "exists" }],
        completionEvidence: ["script exists"],
        verificationHints: [],
        blockers: [],
      },
      changedFiles: ["src/experiments/train_hgb_engineered_auc.py"],
      commandResults: [{
        toolName: "shell_command",
        command: "test -f src/experiments/train_hgb_engineered_auc.py",
        cwd: process.cwd(),
        success: true,
        category: "verification",
        evidenceEligible: true,
        outputSummary: "exists",
        durationMs: 1,
      }],
      calledTools: ["shell_command"],
      modelTurns: 2,
      toolCalls: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toContain("Artifact contract verification failed");
    expect(result.reasons.join("\n")).toContain("reports/hgb_seed_blend.json is missing");
    expect(result.reasons.join("\n")).toContain("submissions/hgb_seed_blend.csv is missing");
  });

  it("rejects done when artifact evidence is required but no artifacts are declared", async () => {
    const modelInfo = makeModelInfo();
    const turn = buildTaskAgentLoopTurnContext({
      task: makeKaggleArtifactTask({
        artifact_contract: { required: true, required_artifacts: [] },
      }),
      model: modelInfo.ref,
      modelInfo,
      session: createAgentLoopSession(),
      cwd: process.cwd(),
    });

    const result = await turn.completionValidator!({
      output: {
        status: "done",
        finalAnswer: "Implemented the training script.",
        summary: "script only",
        filesChanged: [],
        testsRun: [{ command: "test -f src/experiments/train_hgb_engineered_auc.py", passed: true, outputSummary: "exists" }],
        completionEvidence: ["script exists"],
        verificationHints: [],
        blockers: [],
      },
      changedFiles: [],
      commandResults: [{
        toolName: "shell_command",
        command: "test -f src/experiments/train_hgb_engineered_auc.py",
        cwd: process.cwd(),
        success: true,
        category: "verification",
        evidenceEligible: true,
        outputSummary: "exists",
        durationMs: 1,
      }],
      calledTools: ["shell_command"],
      modelTurns: 2,
      toolCalls: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toContain("no required_artifacts were declared");
  });

  it("rejects done when goal constraints require artifacts but the task contract opted out", async () => {
    const modelInfo = makeModelInfo();
    const turn = buildTaskAgentLoopTurnContext({
      task: makeKaggleArtifactTask({
        artifact_contract: { required: false, required_artifacts: [] },
      }),
      artifactGoal: { constraints: ["run_spec_profile:kaggle"] },
      model: modelInfo.ref,
      modelInfo,
      session: createAgentLoopSession(),
      cwd: process.cwd(),
    });

    const result = await turn.completionValidator!({
      output: {
        status: "done",
        finalAnswer: "Implemented the training script.",
        summary: "script only",
        filesChanged: [],
        testsRun: [{ command: "test -f src/experiments/train_hgb_engineered_auc.py", passed: true, outputSummary: "exists" }],
        completionEvidence: ["script exists"],
        verificationHints: [],
        blockers: [],
      },
      changedFiles: [],
      commandResults: [{
        toolName: "shell_command",
        command: "test -f src/experiments/train_hgb_engineered_auc.py",
        cwd: process.cwd(),
        success: true,
        category: "verification",
        evidenceEligible: true,
        outputSummary: "exists",
        durationMs: 1,
      }],
      calledTools: ["shell_command"],
      modelTurns: 2,
      toolCalls: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.reasons.join("\n")).toContain("no required_artifacts were declared");
  });

  it("rejects done when a required contract declares metrics but no submission artifact", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-agentloop-artifacts-"));
    try {
      const metricsPath = path.join(workspace, "reports", "hgb_seed_blend.json");
      fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
      fs.writeFileSync(metricsPath, JSON.stringify({ balanced_accuracy: 0.95 }), "utf8");
      const modelInfo = makeModelInfo();
      const turn = buildTaskAgentLoopTurnContext({
        task: makeKaggleArtifactTask({
          success_criteria: [
            {
              description: "Metrics artifact exists",
              verification_method: "test -f reports/hgb_seed_blend.json",
              is_blocking: true,
            },
          ],
          artifact_contract: {
            required: true,
            required_artifacts: [
              {
                kind: "metrics_json",
                path: "reports/hgb_seed_blend.json",
                required_fields: ["balanced_accuracy"],
                fresh_after_task_start: true,
              },
            ],
          },
        }),
        artifactGoal: { constraints: ["run_spec_profile:kaggle"] },
        model: modelInfo.ref,
        modelInfo,
        session: createAgentLoopSession(),
        cwd: workspace,
      });

      const result = await turn.completionValidator!({
        output: {
          status: "done",
          finalAnswer: "Produced a fresh metrics JSON.",
          summary: "metrics only",
          filesChanged: ["reports/hgb_seed_blend.json"],
          testsRun: [{ command: "test -f reports/hgb_seed_blend.json", passed: true, outputSummary: "exists" }],
          completionEvidence: ["fresh metrics json exists"],
          verificationHints: [],
          blockers: [],
        },
        changedFiles: ["reports/hgb_seed_blend.json"],
        commandResults: [{
          toolName: "shell_command",
          command: "test -f reports/hgb_seed_blend.json",
          cwd: workspace,
          success: true,
          category: "verification",
          evidenceEligible: true,
          outputSummary: "exists",
          durationMs: 1,
        }],
        calledTools: ["shell_command"],
        modelTurns: 2,
        toolCalls: 1,
      });

      expect(result.ok).toBe(false);
      expect(result.reasons.join("\n")).toContain("missing required artifact kind(s): submission_csv");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("allows a typed blocked result without artifact evidence", async () => {
    const modelInfo = makeModelInfo();
    const turn = buildTaskAgentLoopTurnContext({
      task: makeKaggleArtifactTask(),
      model: modelInfo.ref,
      modelInfo,
      session: createAgentLoopSession(),
      cwd: process.cwd(),
    });

    const result = await turn.completionValidator!({
      output: {
        status: "blocked",
        finalAnswer: "Experiment execution could not run.",
        summary: "blocked",
        filesChanged: [],
        testsRun: [],
        completionEvidence: [],
        verificationHints: [],
        blockers: ["local Kaggle data is unavailable"],
      },
      changedFiles: [],
      commandResults: [],
      calledTools: [],
      modelTurns: 1,
      toolCalls: 0,
    });

    expect(result).toEqual({ ok: true, reasons: [] });
  });
});
