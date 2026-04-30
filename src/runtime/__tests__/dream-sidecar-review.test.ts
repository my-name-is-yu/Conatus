import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StateManager } from "../../base/state/state-manager.js";
import {
  createRuntimeDreamSidecarReview,
} from "../dream-sidecar-review.js";
import { BackgroundRunLedger } from "../store/background-run-store.js";
import { RuntimeEvidenceLedger } from "../store/evidence-ledger.js";
import { makeTempDir } from "../../../tests/helpers/temp-dir.js";

describe("Runtime Dream sidecar review", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(async () => {
    tmpDir = makeTempDir("pulseed-dream-sidecar-");
    stateManager = new StateManager(tmpDir, undefined, { walEnabled: false });
    await stateManager.init();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("attaches to an active background run and returns a read-only review shape", async () => {
    await seedActiveRun("run:coreloop:sidecar");
    const ledger = new RuntimeEvidenceLedger(path.join(tmpDir, "runtime"));
    await ledger.append({
      kind: "metric",
      scope: { run_id: "run:coreloop:sidecar", loop_index: 0 },
      metrics: [{
        label: "accuracy",
        value: 0.72,
        direction: "maximize",
        observed_at: "2026-04-30T00:00:00.000Z",
      }],
      summary: "Initial accuracy.",
      outcome: "continued",
    });
    await ledger.append({
      kind: "dream_checkpoint",
      scope: { run_id: "run:coreloop:sidecar", loop_index: 3, phase: "dream_review_checkpoint" },
      metrics: [{
        label: "accuracy",
        value: 0.91,
        direction: "maximize",
        observed_at: "2026-04-30T00:10:00.000Z",
      }],
      dream_checkpoints: [{
        trigger: "breakthrough",
        summary: "Dream checkpoint found a metric breakthrough.",
        current_goal: "Improve benchmark",
        active_dimensions: ["accuracy"],
        recent_strategy_families: ["bounded ablation"],
        exhausted: ["repeat baseline"],
        promising: ["lock current approach"],
        relevant_memories: [{
          source_type: "soil",
          ref: "soil://run/sidecar",
          summary: "Prior run preserved a breakthrough before finalization.",
          authority: "advisory_only",
        }],
        next_strategy_candidates: [{
          title: "Lock current approach",
          rationale: "Confirm the breakthrough is stable before broadening.",
          target_dimensions: ["accuracy"],
        }],
        guidance: "Preserve the breakthrough before generating broader tasks.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.88,
      }],
      raw_refs: [{ kind: "dream_soil_memory", id: "soil://run/sidecar" }],
      summary: "Breakthrough checkpoint saved.",
      outcome: "improved",
    });

    const review = await createRuntimeDreamSidecarReview({
      stateManager,
      runId: "run:coreloop:sidecar",
    });

    expect(review).toMatchObject({
      schema_version: "runtime-dream-sidecar-review-v1",
      attach_status: "active",
      read_only_enforced: true,
      run: { id: "run:coreloop:sidecar", status: "running" },
      runtime_session: { id: "session:coreloop:sidecar-worker", attachable: true },
      trend_state: { state: "breakthrough", metric_key: "accuracy" },
      best_evidence: { kind: "dream_checkpoint", outcome: "improved" },
      guidance_injection: { status: "not_requested", approval_required: false },
    });
    expect(review.strategy_families).toContain("bounded ablation");
    expect(review.advisory_memories).toContainEqual(expect.objectContaining({
      ref: "soil://run/sidecar",
      authority: "advisory_only",
    }));
    expect(review.suggested_next_moves).toContainEqual(expect.objectContaining({
      title: "Lock current approach",
      source: "dream_checkpoint",
    }));
    expect(review.evidence_refs).toContainEqual(expect.objectContaining({
      kind: "evidence_ledger",
      id: "run:coreloop:sidecar",
    }));
  });

  it("rejects a missing background run", async () => {
    await expect(createRuntimeDreamSidecarReview({
      stateManager,
      runId: "run:missing",
    })).rejects.toMatchObject({
      code: "missing_run",
    });
  });

  it("rejects a stale non-active background run", async () => {
    await seedActiveRun("run:coreloop:stale");
    await new BackgroundRunLedger(path.join(tmpDir, "runtime")).terminal("run:coreloop:stale", {
      status: "succeeded",
      completed_at: "2026-04-30T01:00:00.000Z",
      summary: "Done.",
    });

    await expect(createRuntimeDreamSidecarReview({
      stateManager,
      runId: "run:coreloop:stale",
    })).rejects.toMatchObject({
      code: "stale_run",
    });
  });

  it("keeps optional guidance injection approval-gated", async () => {
    await seedActiveRun("run:coreloop:inject");

    const review = await createRuntimeDreamSidecarReview({
      stateManager,
      runId: "run:coreloop:inject",
      requestGuidanceInjection: true,
    });

    expect(review.read_only_enforced).toBe(true);
    expect(review.guidance_injection).toMatchObject({
      status: "approval_required",
      approval_required: true,
      target_run_id: "run:coreloop:inject",
    });
    expect(review.operator_decisions).toContainEqual(expect.objectContaining({
      source: "guidance_injection",
      approval_required: true,
    }));
    expect(await new BackgroundRunLedger(path.join(tmpDir, "runtime")).load("run:coreloop:inject")).toMatchObject({
      status: "running",
      summary: "Active sidecar target.",
    });
  });

  it("does not signal or pid-probe a process sidecar while reviewing a ledger run", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    await stateManager.writeRaw("runtime/process-sessions/proc-sidecar.json", {
      session_id: "proc-sidecar",
      label: "training",
      command: "node",
      args: ["train.js"],
      cwd: "/repo",
      pid: 424242,
      running: true,
      exitCode: null,
      signal: null,
      startedAt: "2026-04-30T00:00:00.000Z",
      bufferedChars: 0,
      metadataRelativePath: "runtime/process-sessions/proc-sidecar.json",
      artifactRefs: [],
    });
    const ledger = new BackgroundRunLedger(path.join(tmpDir, "runtime"));
    await ledger.create({
      id: "run:process:proc-sidecar",
      kind: "process_run",
      notify_policy: "silent",
      reply_target_source: "none",
      process_session_id: "proc-sidecar",
      status: "running",
      title: "Training",
      workspace: "/repo",
      started_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T00:10:00.000Z",
      source_refs: [{
        kind: "process_session",
        id: "proc-sidecar",
        path: null,
        relative_path: "runtime/process-sessions/proc-sidecar.json",
        updated_at: "2026-04-30T00:10:00.000Z",
      }],
    });

    try {
      const review = await createRuntimeDreamSidecarReview({
        stateManager,
        runId: "run:process:proc-sidecar",
      });

      expect(review.run).toMatchObject({
        id: "run:process:proc-sidecar",
        status: "running",
        process_session_id: "proc-sidecar",
      });
      expect(review.read_only_enforced).toBe(true);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it("rejects a ledger-running process run when the process sidecar is terminal", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    await stateManager.writeRaw("runtime/process-sessions/proc-stale.json", {
      session_id: "proc-stale",
      label: "training",
      command: "node",
      args: ["train.js"],
      cwd: "/repo",
      pid: 424243,
      running: false,
      exitCode: 0,
      signal: null,
      startedAt: "2026-04-30T00:00:00.000Z",
      exitedAt: "2026-04-30T00:12:00.000Z",
      bufferedChars: 0,
      metadataRelativePath: "runtime/process-sessions/proc-stale.json",
      artifactRefs: [],
    });
    const ledger = new BackgroundRunLedger(path.join(tmpDir, "runtime"));
    await ledger.create({
      id: "run:process:proc-stale",
      kind: "process_run",
      notify_policy: "silent",
      reply_target_source: "none",
      process_session_id: "proc-stale",
      status: "running",
      title: "Training",
      workspace: "/repo",
      started_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T00:10:00.000Z",
      source_refs: [{
        kind: "process_session",
        id: "proc-stale",
        path: null,
        relative_path: "runtime/process-sessions/proc-stale.json",
        updated_at: "2026-04-30T00:10:00.000Z",
      }],
    });

    try {
      await expect(createRuntimeDreamSidecarReview({
        stateManager,
        runId: "run:process:proc-stale",
      })).rejects.toMatchObject({
        code: "stale_run",
      });
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  async function seedActiveRun(runId: string): Promise<void> {
    await stateManager.writeRaw("supervisor-state.json", {
      workers: [{
        workerId: "sidecar-worker",
        goalId: "goal-sidecar",
        startedAt: Date.parse("2026-04-30T00:00:00.000Z"),
        iterations: 3,
      }],
      crashCounts: {},
      suspendedGoals: [],
      updatedAt: Date.parse("2026-04-30T00:30:00.000Z"),
    });
    const ledger = new BackgroundRunLedger(path.join(tmpDir, "runtime"));
    await ledger.create({
      id: runId,
      kind: "coreloop_run",
      notify_policy: "silent",
      reply_target_source: "none",
      child_session_id: "session:coreloop:sidecar-worker",
      title: "Sidecar target",
      workspace: "/repo",
      status: "running",
      started_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T00:30:00.000Z",
      summary: "Active sidecar target.",
      artifacts: [{ label: "metrics.json", path: "/repo/runs/metrics.json", url: null, kind: "metrics" }],
      source_refs: [{
        kind: "supervisor_state",
        id: null,
        path: null,
        relative_path: "runtime/supervisor-state.json",
        updated_at: "2026-04-30T00:30:00.000Z",
      }],
    });
  }
});
