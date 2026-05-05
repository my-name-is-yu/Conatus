import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { RuntimeOperationStore } from "../../store/runtime-operation-store.js";
import { RuntimeControlService } from "../runtime-control-service.js";
import type { RuntimeSessionRegistrySnapshot } from "../../session-registry/types.js";

function snapshotWithRuns(runs: RuntimeSessionRegistrySnapshot["background_runs"]): RuntimeSessionRegistrySnapshot {
  return {
    schema_version: "runtime-session-registry-v1",
    generated_at: "2026-05-02T00:00:00.000Z",
    sessions: [],
    background_runs: runs,
    warnings: [],
  };
}

function makeRun(input: Partial<RuntimeSessionRegistrySnapshot["background_runs"][number]> = {}): RuntimeSessionRegistrySnapshot["background_runs"][number] {
  return {
    schema_version: "background-run-v1",
    id: "run:coreloop:active",
    kind: "coreloop_run",
    parent_session_id: null,
    child_session_id: "session:coreloop:worker-1",
    process_session_id: null,
    goal_id: "goal-1",
    status: "running",
    notify_policy: "done_only",
    reply_target_source: "none",
    pinned_reply_target: null,
    title: "DurableLoop goal goal-1",
    workspace: "/repo",
    created_at: "2026-05-02T00:00:00.000Z",
    started_at: "2026-05-02T00:00:00.000Z",
    updated_at: "2026-05-02T00:00:00.000Z",
    completed_at: null,
    summary: null,
    error: null,
    artifacts: [],
    source_refs: [],
    ...input,
  };
}

describe("RuntimeControlService", () => {
  it("executes approved restart operations through the configured executor", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn().mockResolvedValue({
        ok: true,
        state: "acknowledged",
        message: "reload queued",
      });
      const service = new RuntimeControlService({ operationStore, executor });

      const result = await service.request({
        intent: { kind: "restart_gateway", reason: "gateway を再起動して" },
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(result).toMatchObject({
        success: true,
        message: "reload queued",
        state: "acknowledged",
      });
      expect(executor).toHaveBeenCalledOnce();
      expect(await operationStore.listCompleted()).toHaveLength(0);
      const pending = await operationStore.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        kind: "restart_gateway",
        state: "acknowledged",
        expected_health: {
          daemon_ping: true,
          gateway_acceptance: true,
        },
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("routes reload_config through approval and executor support", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-reload-config-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn().mockResolvedValue({ ok: true, state: "verified", message: "config reloaded" });
      const service = new RuntimeControlService({ operationStore, executor });

      const result = await service.request({
        intent: { kind: "reload_config", reason: "runtime 設定を再読み込みして" },
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(result).toMatchObject({
        success: true,
        state: "verified",
        message: "config reloaded",
      });
      expect(executor).toHaveBeenCalledOnce();
      expect(await operationStore.listPending()).toHaveLength(0);
      expect(await operationStore.listCompleted()).toHaveLength(1);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("records cancelled operations when required approval is rejected", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-rejected-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn();
      const service = new RuntimeControlService({ operationStore, executor });

      const result = await service.request({
        intent: { kind: "restart_daemon", reason: "PulSeed を再起動して" },
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(false),
      });

      expect(result).toMatchObject({
        success: false,
        message: "Runtime control operation was not approved.",
        state: "cancelled",
      });
      expect(executor).not.toHaveBeenCalled();
      expect(await operationStore.listPending()).toHaveLength(0);
      const completed = await operationStore.listCompleted();
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({
        kind: "restart_daemon",
        state: "cancelled",
        result: {
          ok: false,
          message: "Runtime control operation was not approved.",
        },
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("routes typed pause and resume through the selected run goal bridge", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-run-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn().mockResolvedValue({
        ok: true,
        state: "running",
        message: "typed run control sent",
      });
      const evidenceLedger = { append: vi.fn().mockResolvedValue([]) };
      const service = new RuntimeControlService({
        operationStore,
        executor,
        evidenceLedger,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([makeRun()])),
        },
      });

      const pause = await service.pauseRun({
        runId: "run:coreloop:active",
        reason: "pause this run",
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });
      const resume = await service.resumeRun({
        runId: "run:coreloop:active",
        reason: "resume this run",
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(pause).toMatchObject({ success: true, message: "typed run control sent", state: "running" });
      expect(resume).toMatchObject({ success: true, message: "typed run control sent", state: "running" });
      expect(executor).toHaveBeenCalledTimes(2);
      expect(executor.mock.calls[0][0]).toMatchObject({
        kind: "pause_run",
        target: { run_id: "run:coreloop:active", goal_id: "goal-1" },
      });
      expect(executor.mock.calls[1][0]).toMatchObject({
        kind: "resume_run",
        target: { run_id: "run:coreloop:active", goal_id: "goal-1" },
      });
      expect(evidenceLedger.append).toHaveBeenCalled();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("returns a typed blocked reason when a selected run has no supported goal bridge", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-run-blocked-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn();
      const service = new RuntimeControlService({
        operationStore,
        executor,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([
            makeRun({ kind: "process_run", id: "run:process:abc", goal_id: null, child_session_id: null, process_session_id: "proc-1" }),
          ])),
        },
      });

      const result = await service.pauseRun({
        runId: "run:process:abc",
        reason: "pause process",
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(result).toMatchObject({
        success: false,
        state: "blocked",
        message: expect.stringContaining("no typed goal/runtime bridge"),
      });
      expect(executor).not.toHaveBeenCalled();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("does not recover runtime-control goal targets from display titles", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-title-target-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn();
      const service = new RuntimeControlService({
        operationStore,
        executor,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([
            makeRun({ goal_id: null, title: "DurableLoop goal goal-from-title" }),
          ])),
        },
      });

      const result = await service.pauseRun({
        runId: "run:coreloop:active",
        reason: "pause this run",
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(result).toMatchObject({
        success: false,
        state: "blocked",
        message: expect.stringContaining("no typed goal/runtime bridge"),
      });
      expect(executor).not.toHaveBeenCalled();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("asks for clarification instead of guessing among multiple active or attention runs", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-run-ambiguous-");
    try {
      const service = new RuntimeControlService({
        operationStore: new RuntimeOperationStore(path.join(tmpDir, "runtime")),
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([
            makeRun({ id: "run:coreloop:a", goal_id: "goal-a" }),
            makeRun({ id: "run:coreloop:b", goal_id: "goal-b" }),
          ])),
        },
      });

      const result = await service.pauseRun({
        reason: "pause this run",
        cwd: "/repo",
      });

      expect(result).toMatchObject({
        success: false,
        state: "blocked",
        message: expect.stringContaining("Multiple runtime runs match this request"),
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("rejects stale terminal runs for control operations", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-run-stale-");
    try {
      const service = new RuntimeControlService({
        operationStore: new RuntimeOperationStore(path.join(tmpDir, "runtime")),
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([
            makeRun({ id: "run:coreloop:old", status: "succeeded", goal_id: "goal-old" }),
          ])),
        },
      });

      const result = await service.pauseRun({
        runId: "run:coreloop:old",
        reason: "pause old run",
        cwd: "/repo",
      });

      expect(result).toMatchObject({
        success: false,
        state: "blocked",
        message: expect.stringContaining("stale or terminal"),
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("records approval-gated finalize proposals without executing external actions", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-finalize-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn();
      const operatorHandoffStore = { create: vi.fn().mockResolvedValue({ handoff_id: "handoff-1" }) };
      const service = new RuntimeControlService({
        operationStore,
        executor,
        operatorHandoffStore,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([makeRun()])),
        },
      });

      const result = await service.finalizeRun({
        runId: "run:coreloop:active",
        reason: "finalize but do not submit externally",
        externalActions: ["submit"],
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(result).toMatchObject({
        success: true,
        state: "blocked",
        message: expect.stringContaining("No external submit/publish/secret/production/destructive action was executed"),
      });
      expect(operatorHandoffStore.create).toHaveBeenCalledWith(expect.objectContaining({
        run_id: "run:coreloop:active",
        triggers: expect.arrayContaining(["finalization", "external_action"]),
      }));
      expect(executor).not.toHaveBeenCalled();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
