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
import { RuntimeEvidenceLedger } from "../../../runtime/store/evidence-ledger.js";

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
      summary: "Focused test passed.",
      outcome: "improved",
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const textCode = await runCLI("runtime", "evidence", "goal-evidence");
    const textOutput = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(textCode).toBe(0);
    expect(textOutput).toContain("Runtime evidence: goal goal-evidence");
    expect(textOutput).toContain("Best evidence:");

    logSpy.mockClear();
    const jsonCode = await runCLI("runtime", "evidence", "goal-evidence", "--json");
    const jsonOutput = logSpy.mock.calls.map((call) => call.join("\n")).join("\n");
    const parsed = JSON.parse(jsonOutput) as { total_entries: number; best_evidence: { kind: string } };
    expect(jsonCode).toBe(0);
    expect(parsed.total_entries).toBe(2);
    expect(parsed.best_evidence.kind).toBe("verification");
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
