import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StateManager } from "../../../base/state/state-manager.js";
import { CharacterConfigManager } from "../../../platform/traits/character-config.js";
import { dispatchCommand } from "../cli-command-registry.js";
import { CLIRunner } from "../cli-runner.js";
import type { CoreLoop } from "../../../orchestrator/loop/core-loop.js";
import type { ProcessSessionSnapshot } from "../../../tools/system/ProcessSessionTool/ProcessSessionTool.js";
import { BackgroundRunLedger } from "../../../runtime/store/background-run-store.js";
import { RuntimeEvidenceLedger } from "../../../runtime/store/evidence-ledger.js";
import { RuntimeExperimentQueueStore } from "../../../runtime/store/experiment-queue-store.js";
import { RuntimeBudgetStore } from "../../../runtime/store/budget-store.js";

describe("runtime registry CLI commands", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let characterConfigManager: CharacterConfigManager;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-runtime-cli-"));
    stateManager = new StateManager(tmpDir, undefined, { walEnabled: false });
    await stateManager.init();
    characterConfigManager = new CharacterConfigManager(stateManager);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  async function runCLI(...args: string[]): Promise<number> {
    return dispatchCommand(args, false, stateManager, characterConfigManager, { value: null as CoreLoop | null });
  }

  it("lists runtime sessions from real StateManager registry files", async () => {
    await writeConversationWithRunningAgent();
    await stateManager.writeRaw("supervisor-state.json", {
      workers: [
        {
          workerId: "worker-1",
          goalId: "goal-runtime",
          startedAt: Date.parse("2026-04-25T00:00:00.000Z"),
        },
      ],
      updatedAt: Date.parse("2026-04-25T00:30:00.000Z"),
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI("runtime", "sessions", "--active");
    const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");

    expect(code).toBe(0);
    expect(output).toContain("Runtime sessions:");
    expect(output).toContain("session:agent:agent-session-a");
    expect(output).toContain("session:coreloop:worker-1");
    expect(output).not.toContain("session:conversation:chat-a");
  });

  it("reads runtime sessions through CLIRunner baseDir routing", async () => {
    await writeConversationWithRunningAgent();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await new CLIRunner(tmpDir).run(["runtime", "sessions", "--json"]);
    const output = logSpy.mock.calls.map((call) => call.join("\n")).join("\n");
    const parsed = JSON.parse(output) as {
      sessions: Array<{ id: string; parent_session_id: string | null }>;
    };

    expect(code).toBe(0);
    expect(parsed.sessions).toContainEqual(expect.objectContaining({
      id: "session:conversation:chat-a",
    }));
    expect(parsed.sessions).toContainEqual(expect.objectContaining({
      id: "session:agent:agent-session-a",
      parent_session_id: "session:conversation:chat-a",
    }));
  });

  it("prints JSON list output with generated_at and warnings envelope", async () => {
    await writeConversationWithRunningAgent();
    await fsp.mkdir(path.join(tmpDir, "runtime", "process-sessions"), { recursive: true });
    await fsp.writeFile(path.join(tmpDir, "runtime", "process-sessions", "bad.json"), "{not-json", "utf-8");
    await stateManager.writeRaw("runtime/process-sessions/proc-failed.json", makeProcessSnapshot({
      session_id: "proc-failed",
      running: false,
      exitCode: 1,
      exitedAt: "2026-04-25T01:00:00.000Z",
    }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI("runtime", "runs", "--json", "--attention");
    const output = logSpy.mock.calls.map((call) => call.join("\n")).join("\n");
    const parsed = JSON.parse(output) as {
      schema_version: string;
      generated_at: string;
      warnings: Array<{ code: string }>;
      background_runs: Array<{ id: string; status: string }>;
    };

    expect(code).toBe(0);
    expect(parsed.schema_version).toBe("runtime-session-registry-v1");
    expect(parsed.generated_at).toEqual(expect.any(String));
    expect(parsed.warnings).toContainEqual(expect.objectContaining({ code: "source_parse_failed" }));
    expect(parsed.background_runs).toEqual([
      expect.objectContaining({
        id: "run:process:proc-failed",
        status: "failed",
      }),
    ]);
  });

  it("shows one runtime session as JSON", async () => {
    await writeConversationWithRunningAgent();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI("runtime", "session", "session:agent:agent-session-a", "--json");
    const output = logSpy.mock.calls.map((call) => call.join("\n")).join("\n");
    const parsed = JSON.parse(output) as { id: string; kind: string; status: string };

    expect(code).toBe(0);
    expect(parsed).toMatchObject({
      id: "session:agent:agent-session-a",
      kind: "agent",
      status: "active",
    });
  });

  it("shows one runtime run as JSON", async () => {
    await stateManager.writeRaw("runtime/process-sessions/proc-ok.json", makeProcessSnapshot({
      session_id: "proc-ok",
      running: false,
      exitCode: 0,
      exitedAt: "2026-04-25T01:00:00.000Z",
    }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI("runtime", "run", "run:process:proc-ok", "--json");
    const output = logSpy.mock.calls.map((call) => call.join("\n")).join("\n");
    const parsed = JSON.parse(output) as { id: string; kind: string; status: string };

    expect(code).toBe(0);
    expect(parsed).toMatchObject({
      id: "run:process:proc-ok",
      kind: "process_run",
      status: "succeeded",
    });
  });

  it("returns 1 and writes console.error for missing detail records", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCLI("runtime", "run", "run:process:missing", "--json");
    const errors = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");

    expect(code).toBe(1);
    expect(errors).toContain("Runtime run not found: run:process:missing");
  });

  it("summarizes runtime evidence for a goal as text and JSON", async () => {
    const ledger = new RuntimeEvidenceLedger(path.join(tmpDir, "runtime"));
    await ledger.append({
      kind: "strategy",
      scope: { goal_id: "goal-evidence", loop_index: 0 },
      summary: "Continue with the narrowed implementation path.",
      outcome: "continued",
    });
    await ledger.append({
      kind: "verification",
      scope: { goal_id: "goal-evidence", task_id: "task-evidence", loop_index: 0 },
      verification: { verdict: "pass", confidence: 0.95, summary: "focused test passed" },
      artifacts: [{ label: "final-report", state_relative_path: "reports/final.md", kind: "report", retention_class: "final_deliverable", size_bytes: 42 }],
      summary: "Focused test passed.",
      outcome: "improved",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const textCode = await runCLI("runtime", "evidence", "goal-evidence");
    const textOutput = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(textCode).toBe(0);
    expect(textOutput).toContain("Runtime evidence: goal goal-evidence");
    expect(textOutput).toContain("Best evidence:");
    expect(textOutput).toContain("Artifact footprint:");
    expect(textOutput).toContain("1 protected");

    logSpy.mockClear();
    const jsonCode = await runCLI("runtime", "evidence", "goal-evidence", "--json");
    const jsonOutput = logSpy.mock.calls.map((call) => call.join("\n")).join("\n");
    const parsed = JSON.parse(jsonOutput) as { total_entries: number; best_evidence: { kind: string }; artifact_retention: { total_artifacts: number; protected_count: number } };
    expect(jsonCode).toBe(0);
    expect(parsed.total_entries).toBe(2);
    expect(parsed.best_evidence.kind).toBe("verification");
    expect(parsed.artifact_retention).toMatchObject({ total_artifacts: 1, protected_count: 1 });
  });

  it("shows evaluator local best, external best, gap, and approval gate in runtime evidence", async () => {
    const ledger = new RuntimeEvidenceLedger(path.join(tmpDir, "runtime"));
    await ledger.append({
      kind: "evaluator",
      scope: { goal_id: "goal-evaluator-cli" },
      evaluators: [{
        evaluator_id: "ci",
        signal: "local",
        source: "local-tests",
        candidate_id: "candidate-a",
        status: "ready",
        score: 1,
        direction: "maximize",
        publish_action: {
          id: "publish-ci-artifact",
          label: "Publish CI artifact",
          approval_required: true,
        },
      }],
      summary: "Local tests selected candidate A.",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const pendingCode = await runCLI("runtime", "evidence", "goal-evaluator-cli");
    const pendingOutput = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");

    expect(pendingCode).toBe(0);
    expect(pendingOutput).toContain("Approval needed:");
    expect(pendingOutput).toContain("pending_external");

    logSpy.mockClear();
    await ledger.append({
      kind: "evaluator",
      scope: { goal_id: "goal-evaluator-cli" },
      evaluators: [{
        evaluator_id: "ci",
        signal: "external",
        source: "github-actions",
        candidate_id: "candidate-a",
        status: "passed",
        score: 1,
        expected_score: 1,
        direction: "maximize",
        provenance: {
          kind: "ci",
          url: "https://example.com/actions/runs/123",
          run_id: "gha-123",
        },
      }],
      summary: "External CI passed.",
    });

    const textCode = await runCLI("runtime", "evidence", "goal-evaluator-cli");
    const textOutput = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");

    expect(textCode).toBe(0);
    expect(textOutput).toContain("Evaluators:");
    expect(textOutput).toContain("Local best:");
    expect(textOutput).toContain("External best:");
    expect(textOutput).toContain("external_success");

    logSpy.mockClear();
    const jsonCode = await runCLI("runtime", "evidence", "goal-evaluator-cli", "--json");
    const jsonOutput = logSpy.mock.calls.map((call) => call.join("\n")).join("\n");
    const parsed = JSON.parse(jsonOutput) as {
      evaluator_summary: {
        local_best: { candidate_id: string };
        external_best: { provenance: { run_id: string } };
        gap: { kind: string };
      };
    };
    expect(jsonCode).toBe(0);
    expect(parsed.evaluator_summary.local_best.candidate_id).toBe("candidate-a");
    expect(parsed.evaluator_summary.external_best.provenance.run_id).toBe("gha-123");
    expect(parsed.evaluator_summary.gap.kind).toBe("external_success");
  });

  it("shows public research source summaries in runtime evidence", async () => {
    const ledger = new RuntimeEvidenceLedger(path.join(tmpDir, "runtime"));
    await ledger.append({
      kind: "research",
      scope: { goal_id: "goal-research-cli", phase: "public_research" },
      research: [{
        trigger: "plateau",
        query: "plateau strategy evidence",
        summary: "Source-grounded memo found one bounded experiment.",
        sources: [{
          url: "https://example.com/research/plateau",
          title: "Plateau strategy",
          source_type: "writeup",
          provenance: "summarized",
        }],
        findings: [{
          finding: "Compare a single alternative before expanding scope.",
          source_urls: ["https://example.com/research/plateau"],
          applicability: "Applies when metric trend has plateaued.",
          risks_constraints: ["Keep external actions approval-gated."],
          proposed_experiment: "Run one local ablation.",
          expected_metric_impact: "Could reveal a better strategy.",
          fact_vs_adaptation: {
            facts: ["The source recommends bounded comparison."],
            adaptation: "Use one local ablation for this goal.",
          },
        }],
        untrusted_content_policy: "webpage_instructions_are_untrusted",
        external_actions: [],
        confidence: 0.8,
      }],
      raw_refs: [{ kind: "research_source", url: "https://example.com/research/plateau" }],
      summary: "Public research memo saved.",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const textCode = await runCLI("runtime", "evidence", "goal-research-cli");
    const textOutput = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");

    expect(textCode).toBe(0);
    expect(textOutput).toContain("Public research:");
    expect(textOutput).toContain("Source-grounded memo");
    expect(textOutput).toContain("https://example.com/research/plateau");

    logSpy.mockClear();
    const jsonCode = await runCLI("runtime", "evidence", "goal-research-cli", "--json");
    const jsonOutput = logSpy.mock.calls.map((call) => call.join("\n")).join("\n");
    const parsed = JSON.parse(jsonOutput) as {
      research_memos: Array<{ sources: Array<{ url: string }>; findings: Array<{ applicability: string }> }>;
    };
    expect(jsonCode).toBe(0);
    expect(parsed.research_memos[0]?.sources[0]?.url).toBe("https://example.com/research/plateau");
    expect(parsed.research_memos[0]?.findings[0]?.applicability).toBe("Applies when metric trend has plateaued.");
  });

  it("shows Dream review checkpoint guidance in runtime evidence", async () => {
    const ledger = new RuntimeEvidenceLedger(path.join(tmpDir, "runtime"));
    await ledger.append({
      kind: "dream_checkpoint",
      scope: { goal_id: "goal-dream-cli", loop_index: 3, phase: "dream_review_checkpoint" },
      dream_checkpoints: [{
        trigger: "breakthrough",
        summary: "Dream checkpoint recommends exploiting the latest metric breakthrough.",
        current_goal: "Improve benchmark score",
        active_dimensions: ["accuracy", "stability"],
        best_evidence_so_far: "Accuracy jumped from 0.72 to 0.91.",
        recent_strategy_families: ["exploit"],
        exhausted: [],
        promising: ["lock current approach"],
        relevant_memories: [{
          source_type: "playbook",
          ref: "playbook://breakthrough-finalization",
          summary: "Checkpoint before finalization.",
          authority: "advisory_only",
        }],
        active_hypotheses: [],
        rejected_approaches: [],
        next_strategy_candidates: [{
          title: "Lock current approach",
          rationale: "Avoid losing a high-signal breakthrough.",
          target_dimensions: ["accuracy"],
          expected_evidence_gain: "Confirms the improvement is stable.",
        }],
        guidance: "Generate the next task around preserving the breakthrough.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.88,
      }],
      raw_refs: [{ kind: "dream_playbook_memory", id: "playbook://breakthrough-finalization" }],
      summary: "Dream checkpoint saved.",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const textCode = await runCLI("runtime", "evidence", "goal-dream-cli");
    const textOutput = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");

    expect(textCode).toBe(0);
    expect(textOutput).toContain("Dream checkpoints:");
    expect(textOutput).toContain("breakthrough:");
    expect(textOutput).toContain("accuracy, stability");

    logSpy.mockClear();
    const jsonCode = await runCLI("runtime", "evidence", "goal-dream-cli", "--json");
    const jsonOutput = logSpy.mock.calls.map((call) => call.join("\n")).join("\n");
    const parsed = JSON.parse(jsonOutput) as {
      dream_checkpoints: Array<{ trigger: string; context_authority: string; relevant_memories: Array<{ authority: string }> }>;
    };
    expect(jsonCode).toBe(0);
    expect(parsed.dream_checkpoints[0]).toMatchObject({
      trigger: "breakthrough",
      context_authority: "advisory_only",
      relevant_memories: [{ authority: "advisory_only" }],
    });
  });

  it("prints read-only sidecar Dream review for an active runtime run", async () => {
    const runLedger = new BackgroundRunLedger(path.join(tmpDir, "runtime"));
    await runLedger.create({
      id: "run:coreloop:review-cli",
      kind: "coreloop_run",
      notify_policy: "silent",
      reply_target_source: "none",
      status: "running",
      title: "Review CLI target",
      workspace: "/repo",
      started_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T00:10:00.000Z",
      summary: "Running review target.",
    });
    const evidenceLedger = new RuntimeEvidenceLedger(path.join(tmpDir, "runtime"));
    await evidenceLedger.append({
      kind: "strategy",
      scope: { run_id: "run:coreloop:review-cli", loop_index: 0 },
      strategy: "bounded ablation",
      summary: "Try a bounded ablation first.",
      outcome: "continued",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const textCode = await runCLI("runtime", "dream-review", "run:coreloop:review-cli", "--inject-guidance");
    const textOutput = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");

    expect(textCode).toBe(0);
    expect(textOutput).toContain("Runtime Dream review: run:coreloop:review-cli");
    expect(textOutput).toContain("Mode:            read_only");
    expect(textOutput).toContain("Guidance injection: approval_required");

    logSpy.mockClear();
    const jsonCode = await runCLI("runtime", "dream-review", "run:coreloop:review-cli", "--json");
    const jsonOutput = logSpy.mock.calls.map((call) => call.join("\n")).join("\n");
    const parsed = JSON.parse(jsonOutput) as {
      attach_status: string;
      read_only_enforced: boolean;
      strategy_families: string[];
    };
    expect(jsonCode).toBe(0);
    expect(parsed.attach_status).toBe("active");
    expect(parsed.read_only_enforced).toBe(true);
    expect(parsed.strategy_families).toContain("bounded ablation");
  });

  it("summarizes run-scoped evidence for non-prefixed long-running run IDs", async () => {
    const ledger = new RuntimeEvidenceLedger(path.join(tmpDir, "runtime"));
    await ledger.append({
      kind: "artifact",
      scope: { run_id: "dummy-runtime-run" },
      summary: "Long-running report written.",
      artifacts: [{ label: "summary.md", path: "/tmp/summary.md", kind: "report" }],
      outcome: "improved",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await runCLI("runtime", "evidence", "dummy-runtime-run", "--json");
    const output = logSpy.mock.calls.map((call) => call.join("\n")).join("\n");
    const parsed = JSON.parse(output) as { scope: { run_id?: string }; total_entries: number };

    expect(code).toBe(0);
    expect(parsed.scope.run_id).toBe("dummy-runtime-run");
    expect(parsed.total_entries).toBe(1);
  });

  it("reports experiment queue phase separately from frozen execution status", async () => {
    const queueStore = new RuntimeExperimentQueueStore(path.join(tmpDir, "runtime"));
    await queueStore.create({
      queue_id: "queue-runtime",
      goal_id: "goal-runtime",
      run_id: "run:coreloop:goal-runtime",
      title: "Frozen queue",
      created_at: "2026-05-01T00:00:00.000Z",
      provenance: { source: "test-plan", evidence_refs: ["evidence:plan"] },
      items: [{
        item_id: "exp-a",
        title: "Experiment A",
        config: { model: "catboost" },
        provenance: { source: "test-plan" },
      }],
    });
    await queueStore.freeze("queue-runtime", "2026-05-01T00:01:00.000Z");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const listCode = await runCLI("runtime", "experiment-queues", "--json");
    const listOutput = logSpy.mock.calls.map((call) => call.join("\n")).join("\n");
    const listParsed = JSON.parse(listOutput) as {
      queues: Array<{ queue_id: string; current_version: number; revisions: Array<{ phase: string; status: string }> }>;
    };

    expect(listCode).toBe(0);
    expect(listParsed.queues).toContainEqual(expect.objectContaining({
      queue_id: "queue-runtime",
      current_version: 1,
      revisions: [expect.objectContaining({
        phase: "executing_frozen_queue",
        status: "frozen",
      })],
    }));

    logSpy.mockClear();
    const detailCode = await runCLI("runtime", "experiment-queue", "queue-runtime");
    const detailOutput = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");

    expect(detailCode).toBe(0);
    expect(detailOutput).toContain("Runtime experiment queue: queue-runtime");
    expect(detailOutput).toContain("Phase:       executing_frozen_queue");
    expect(detailOutput).toContain("Next item:   exp-a");
  });

  it("reports runtime budget remaining usage and task generation context", async () => {
    const budgetStore = new RuntimeBudgetStore(path.join(tmpDir, "runtime"));
    await budgetStore.create({
      budget_id: "budget-runtime",
      scope: { goal_id: "goal-runtime", run_id: "run:coreloop:goal-runtime" },
      title: "Runtime budget",
      created_at: "2026-05-01T00:00:00.000Z",
      limits: [
        {
          dimension: "evaluator_attempts",
          limit: 3,
          approval_at_remaining: 1,
          mode_transition_at_remaining: { consolidation: 1 },
        },
      ],
    });
    await budgetStore.recordEvaluatorCall("budget-runtime", {
      attempts: 2,
      observed_at: "2026-05-01T00:01:00.000Z",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const listCode = await runCLI("runtime", "budgets", "--json");
    const listOutput = logSpy.mock.calls.map((call) => call.join("\n")).join("\n");
    const listParsed = JSON.parse(listOutput) as {
      budgets: Array<{ budget: { budget_id: string }; status: { mode: string; approval_required: boolean } }>;
    };

    expect(listCode).toBe(0);
    expect(listParsed.budgets).toContainEqual(expect.objectContaining({
      budget: expect.objectContaining({ budget_id: "budget-runtime" }),
      status: expect.objectContaining({
        mode: "consolidation",
        approval_required: true,
      }),
    }));

    logSpy.mockClear();
    const detailCode = await runCLI("runtime", "budget", "budget-runtime", "--json");
    const detailOutput = logSpy.mock.calls.map((call) => call.join("\n")).join("\n");
    const detailParsed = JSON.parse(detailOutput) as {
      status: { dimensions: Array<{ dimension: string; remaining: number }> };
      task_generation_context: { mode: string; remaining: Record<string, number>; approval_required: boolean };
    };

    expect(detailCode).toBe(0);
    expect(detailParsed.status.dimensions).toContainEqual(expect.objectContaining({
      dimension: "evaluator_attempts",
      remaining: 1,
    }));
    expect(detailParsed.task_generation_context).toMatchObject({
      mode: "consolidation",
      approval_required: true,
      remaining: { evaluator_attempts: 1 },
    });
  });

  async function writeConversationWithRunningAgent(): Promise<void> {
    await stateManager.writeRaw("chat/sessions/chat-a.json", {
      id: "chat-a",
      cwd: "/repo",
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:10:00.000Z",
      title: "Runtime registry",
      messages: [],
      agentLoopStatePath: "chat/agentloop/agent-a.state.json",
      agentLoopStatus: "running",
      agentLoopResumable: true,
      agentLoopUpdatedAt: "2026-04-25T00:11:00.000Z",
    });
    await stateManager.writeRaw("chat/agentloop/agent-a.state.json", {
      sessionId: "agent-session-a",
      traceId: "trace-a",
      turnId: "turn-a",
      goalId: "goal-a",
      cwd: "/repo",
      modelRef: "native:test",
      messages: [],
      modelTurns: 1,
      toolCalls: 0,
      compactions: 0,
      completionValidationAttempts: 0,
      calledTools: [],
      lastToolLoopSignature: null,
      repeatedToolLoopCount: 0,
      finalText: "",
      status: "running",
      updatedAt: "2026-04-25T00:12:00.000Z",
    });
  }
});

function makeProcessSnapshot(overrides: Partial<ProcessSessionSnapshot> = {}): ProcessSessionSnapshot {
  return {
    session_id: overrides.session_id ?? "proc-1",
    label: overrides.label ?? "training",
    command: overrides.command ?? "node",
    args: overrides.args ?? ["train.js"],
    cwd: overrides.cwd ?? "/repo",
    pid: overrides.pid ?? 12345,
    running: overrides.running ?? true,
    exitCode: overrides.exitCode ?? null,
    signal: overrides.signal ?? null,
    startedAt: overrides.startedAt ?? "2026-04-25T00:00:00.000Z",
    ...(overrides.exitedAt ? { exitedAt: overrides.exitedAt } : {}),
    bufferedChars: overrides.bufferedChars ?? 0,
    metadataRelativePath: overrides.metadataRelativePath ?? `runtime/process-sessions/${overrides.session_id ?? "proc-1"}.json`,
    artifactRefs: overrides.artifactRefs ?? [],
  };
}
