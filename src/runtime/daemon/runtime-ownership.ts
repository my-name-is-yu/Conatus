import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { Logger } from "../logger.js";
import { ProactiveInterventionStore } from "../store/index.js";
import type { ApprovalStore, OutboxStore, RuntimeHealthStore } from "../store/index.js";
import type { LeaderLockManager } from "../leader-lock-manager.js";
import { summarizeTaskOutcomeLedgers } from "../../orchestrator/execution/task/task-outcome-ledger.js";
import {
  buildLongRunHealth,
  evolveRuntimeHealthKpi,
  type RuntimeDaemonHealth,
  type RuntimeHealthCapabilityStatuses,
  type RuntimeLongRunHealth,
  type RuntimeLongRunHealthSignals,
} from "../store/index.js";

export type RuntimeHealthComponents = Record<
  "gateway" | "queue" | "leases" | "approval" | "outbox" | "supervisor",
  "ok" | "degraded"
>;

interface RuntimeOwnershipDeps {
  baseDir: string | null;
  runtimeRoot: string | null;
  logger: Logger;
  approvalStore: ApprovalStore | null;
  outboxStore: OutboxStore | null;
  runtimeHealthStore: RuntimeHealthStore | null;
  leaderLockManager: LeaderLockManager | null;
  onLeadershipLost: (reason: string) => void;
}

interface RuntimeTaskOutcomeDetails {
  success_rate: number | null;
  terminal_counts: {
    total_tasks: number;
    terminal_tasks: number;
    succeeded: number;
    failed: number;
    abandoned: number;
    retried: number;
  };
  failure_reasons: {
    timeout: number;
    cancelled: number;
    error: number;
    unknown: number;
    other: number;
  };
  healthy_at_0_95: boolean | null;
}

interface LatestFileEvidence {
  path: string;
  mtimeMs: number;
  metric?: {
    name: string;
    value: number;
    direction: "maximize" | "minimize";
    observedAt: number;
  };
}

export class RuntimeOwnershipCoordinator {
  private leaderOwnerToken: string | null = null;
  private leaderHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private runtimeHealthPhase = "disabled";
  private runtimeHealthComponents: RuntimeHealthComponents | null = null;

  constructor(private readonly deps: RuntimeOwnershipDeps) {}

  private deriveCapabilityStatuses(
    components: RuntimeHealthComponents
  ): RuntimeHealthCapabilityStatuses {
    return {
      process_alive: "ok",
      command_acceptance:
        components.gateway === "ok" && components.queue === "ok" ? "ok" : "degraded",
      task_execution:
        components.supervisor === "ok" && components.leases === "ok" ? "ok" : "degraded",
    };
  }

  private mergeCapabilityStatus(
    previous: RuntimeHealthCapabilityStatuses[keyof RuntimeHealthCapabilityStatuses] | undefined,
    derived: RuntimeHealthCapabilityStatuses[keyof RuntimeHealthCapabilityStatuses]
  ): RuntimeHealthCapabilityStatuses[keyof RuntimeHealthCapabilityStatuses] {
    const rank = { ok: 0, degraded: 1, failed: 2 } as const;
    if (!previous) {
      return derived;
    }
    return rank[previous] >= rank[derived] ? previous : derived;
  }

  private summarizeComponents(components: RuntimeHealthComponents | null): RuntimeDaemonHealth["status"] {
    if (!components) {
      return "degraded";
    }
    return Object.values(components).every((value) => value === "ok") ? "ok" : "degraded";
  }

  private async summarizeTaskOutcomeDetails(): Promise<RuntimeTaskOutcomeDetails | null> {
    if (!this.deps.baseDir) {
      return null;
    }

    const summary = await summarizeTaskOutcomeLedgers(this.deps.baseDir);
    return {
      success_rate: summary.success_rate,
      terminal_counts: {
        total_tasks: summary.total_tasks,
        terminal_tasks: summary.terminal_tasks,
        succeeded: summary.succeeded,
        failed: summary.failed,
        abandoned: summary.abandoned,
        retried: summary.retried,
      },
      failure_reasons: summary.failure_stopped_reasons,
      healthy_at_0_95: summary.success_rate === null ? null : summary.success_rate >= 0.95,
    };
  }

  private async buildHealthDetails(phase: string): Promise<Record<string, unknown>> {
    const details: Record<string, unknown> = {
      pid: process.pid,
      runtime_journal_v2: true,
      runtime_root: this.deps.runtimeRoot,
      phase,
    };
    const taskOutcome = await this.summarizeTaskOutcomeDetails();
    if (taskOutcome) {
      details.task_success_rate = taskOutcome.success_rate;
      details.task_outcome = taskOutcome;
    }
    details.proactive_interventions = await new ProactiveInterventionStore(this.deps.runtimeRoot ?? undefined).summarize();
    return details;
  }

  private freshnessStatus(
    observedAt: number | undefined,
    checkedAt: number,
    staleAfterMs: number
  ): "fresh" | "stale" | "missing" {
    if (observedAt === undefined) {
      return "missing";
    }
    return checkedAt - observedAt <= staleAfterMs ? "fresh" : "stale";
  }

  private async statFile(filePath: string): Promise<number | undefined> {
    try {
      return Math.floor((await fsp.stat(filePath)).mtimeMs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  private async latestKnownLogEvidence(): Promise<LatestFileEvidence | null> {
    if (!this.deps.baseDir) {
      return null;
    }

    const candidates = [
      path.join(this.deps.baseDir, "logs", "coreloop.log"),
      path.join(this.deps.baseDir, "logs", "pulseed.log"),
    ];
    let latest: LatestFileEvidence | null = null;
    for (const candidate of candidates) {
      const mtimeMs = await this.statFile(candidate);
      if (mtimeMs === undefined) continue;
      if (!latest || mtimeMs > latest.mtimeMs) {
        latest = { path: candidate, mtimeMs };
      }
    }
    return latest;
  }

  private async latestArtifactEvidence(): Promise<LatestFileEvidence | null> {
    if (!this.deps.runtimeRoot) {
      return null;
    }

    const artifactsDir = path.join(this.deps.runtimeRoot, "artifacts");
    const latestArtifact = await this.findLatestFile(artifactsDir, (filePath) =>
      filePath.endsWith("result.json") ||
      filePath.endsWith("summary.md") ||
      filePath.endsWith("next-action.json")
    );
    if (!latestArtifact) {
      return null;
    }

    const latestResult = await this.findLatestFile(artifactsDir, (filePath) => filePath.endsWith("result.json"));
    return {
      ...latestArtifact,
      metric: latestResult
        ? await this.extractMetricFromResultJson(latestResult.path, latestResult.mtimeMs)
        : undefined,
    };
  }

  private async findLatestFile(
    rootDir: string,
    includeFile: (filePath: string) => boolean,
    depth = 0
  ): Promise<LatestFileEvidence | null> {
    if (depth > 3) {
      return null;
    }

    let entries: Dirent[];
    try {
      entries = await fsp.readdir(rootDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }

    let latest: LatestFileEvidence | null = null;
    for (const entry of entries) {
      const entryPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        const nested = await this.findLatestFile(entryPath, includeFile, depth + 1);
        if (nested && (!latest || nested.mtimeMs > latest.mtimeMs)) {
          latest = nested;
        }
        continue;
      }

      if (!entry.isFile() || !includeFile(entryPath)) {
        continue;
      }
      const mtimeMs = await this.statFile(entryPath);
      if (mtimeMs !== undefined && (!latest || mtimeMs > latest.mtimeMs)) {
        latest = { path: entryPath, mtimeMs };
      }
    }
    return latest;
  }

  private async extractMetricFromResultJson(
    filePath: string,
    observedAt: number
  ): Promise<LatestFileEvidence["metric"]> {
    try {
      const raw = JSON.parse(await fsp.readFile(filePath, "utf8")) as unknown;
      if (!raw || typeof raw !== "object") {
        return undefined;
      }
      const evidence = (raw as { evidence?: unknown }).evidence;
      if (!Array.isArray(evidence)) {
        return undefined;
      }
      for (const item of evidence) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        if (record["kind"] !== "metric") continue;
        if (typeof record["label"] !== "string") continue;
        if (typeof record["value"] !== "number" || !Number.isFinite(record["value"])) continue;
        return {
          name: record["label"],
          value: record["value"],
          direction: this.extractMetricDirection(record["summary"]),
          observedAt,
        };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private extractMetricDirection(summary: unknown): "maximize" | "minimize" {
    if (typeof summary === "string" && summary.includes("direction=minimize")) {
      return "minimize";
    }
    return "maximize";
  }

  private async readSupervisorActivity(checkedAt: number): Promise<{
    status: RuntimeLongRunHealthSignals["child_activity"]["status"];
    activeCount?: number;
    observedAt?: number;
  }> {
    if (!this.deps.runtimeRoot) {
      return { status: "unknown" };
    }

    const supervisorPath = path.join(this.deps.runtimeRoot, "supervisor-state.json");
    try {
      const raw = JSON.parse(await fsp.readFile(supervisorPath, "utf8")) as unknown;
      const updatedAt = typeof (raw as { updatedAt?: unknown })?.updatedAt === "number"
        ? (raw as { updatedAt: number }).updatedAt
        : checkedAt;
      const workers = Array.isArray((raw as { workers?: unknown })?.workers)
        ? (raw as { workers: Array<Record<string, unknown>> }).workers
        : [];
      const activeCount = workers.filter((worker) => typeof worker["goalId"] === "string").length;
      return {
        status: activeCount > 0 ? "active" : "idle",
        activeCount,
        observedAt: updatedAt,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "unknown" };
      }
      throw err;
    }
  }

  private async buildLongRunHealthSnapshot(checkedAt: number): Promise<RuntimeLongRunHealth> {
    const [previous, logEvidence, artifactEvidence, supervisorActivity, pendingApprovals] = await Promise.all([
      this.deps.runtimeHealthStore?.loadDaemonHealth(),
      this.latestKnownLogEvidence(),
      this.latestArtifactEvidence(),
      this.readSupervisorActivity(checkedAt),
      this.deps.approvalStore?.listPending().catch(() => []),
    ]);
    const previousMetric = previous?.long_running?.signals.metric_progress.current_value;
    const currentMetric = artifactEvidence?.metric?.value;
    const metricDirection = artifactEvidence?.metric?.direction ?? "maximize";
    const metricProgress =
      currentMetric === undefined
        ? "missing"
        : previousMetric === undefined
          ? "unknown"
          : metricDirection === "minimize"
            ? currentMetric < previousMetric
              ? "improved"
              : currentMetric > previousMetric
                ? "regressed"
                : "plateau"
            : currentMetric > previousMetric
            ? "improved"
            : currentMetric < previousMetric
              ? "regressed"
              : "plateau";
    const approvalCount = pendingApprovals?.length ?? 0;
    return buildLongRunHealth({
      process: {
        status: "alive",
        checked_at: checkedAt,
        observed_at: checkedAt,
        pid: process.pid,
      },
      child_activity: {
        status: supervisorActivity.status,
        checked_at: checkedAt,
        observed_at: supervisorActivity.observedAt,
        active_count: supervisorActivity.activeCount,
      },
      log_freshness: {
        status: this.freshnessStatus(logEvidence?.mtimeMs, checkedAt, 5 * 60_000),
        checked_at: checkedAt,
        observed_at: logEvidence?.mtimeMs,
        path: logEvidence?.path,
      },
      artifact_freshness: {
        status: this.freshnessStatus(artifactEvidence?.mtimeMs, checkedAt, 10 * 60_000),
        checked_at: checkedAt,
        observed_at: artifactEvidence?.mtimeMs,
        path: artifactEvidence?.path,
      },
      metric_freshness: {
        status: artifactEvidence?.metric
          ? this.freshnessStatus(artifactEvidence.metric.observedAt, checkedAt, 10 * 60_000)
          : "missing",
        checked_at: checkedAt,
        observed_at: artifactEvidence?.metric?.observedAt,
        metric_name: artifactEvidence?.metric?.name,
      },
      metric_progress: {
        status: metricProgress,
        checked_at: checkedAt,
        observed_at: artifactEvidence?.metric?.observedAt,
        metric_name: artifactEvidence?.metric?.name,
        previous_value: previousMetric,
        current_value: currentMetric,
      },
      blocker: {
        status: approvalCount > 0 ? "approval_wait" : "none",
        checked_at: checkedAt,
        observed_at: checkedAt,
        reason: approvalCount > 0 ? `${approvalCount} pending approval${approvalCount === 1 ? "" : "s"}` : undefined,
      },
      expected_next_checkpoint_at:
        supervisorActivity.status === "active" ? checkedAt + 5 * 60_000 : undefined,
      resumable: true,
    });
  }

  private async saveDaemonHealthWithKpi(params: {
    status: RuntimeDaemonHealth["status"];
    checkedAt: number;
    capabilityStatuses: RuntimeHealthCapabilityStatuses;
    reasons?: Partial<Record<keyof RuntimeHealthCapabilityStatuses, string>>;
  }): Promise<void> {
    const previous = await this.deps.runtimeHealthStore?.loadDaemonHealth();
    await this.deps.runtimeHealthStore?.saveDaemonHealth({
      status: params.status,
      leader: this.leaderOwnerToken !== null,
      checked_at: params.checkedAt,
      kpi: evolveRuntimeHealthKpi(
        previous?.kpi,
        params.capabilityStatuses,
        params.checkedAt,
        params.reasons,
      ),
      long_running: await this.buildLongRunHealthSnapshot(params.checkedAt),
      details: await this.buildHealthDetails(this.runtimeHealthPhase),
    });
  }

  async initializeFoundation(): Promise<void> {
    await Promise.all([
      this.deps.approvalStore?.ensureReady(),
      this.deps.outboxStore?.ensureReady(),
      this.deps.runtimeHealthStore?.ensureReady(),
    ]);

    this.deps.logger.info("Runtime journal foundation initialized", {
      runtime_root: this.deps.runtimeRoot,
      queue_path: this.deps.runtimeRoot ? path.join(this.deps.runtimeRoot, "queue.json") : undefined,
    });
  }

  async saveRuntimeHealthSnapshot(
    phase: string,
    components: RuntimeHealthComponents
  ): Promise<void> {
    this.runtimeHealthPhase = phase;
    this.runtimeHealthComponents = components;
    const checkedAt = Date.now();
    const status = Object.values(components).every((value) => value === "ok") ? "ok" : "degraded";
    const kpiStatuses = this.deriveCapabilityStatuses(components);
    const previous = await this.deps.runtimeHealthStore?.loadDaemonHealth();
    await this.deps.runtimeHealthStore?.saveSnapshot({
      status,
      leader: this.leaderOwnerToken !== null,
      checked_at: checkedAt,
      components,
      kpi: evolveRuntimeHealthKpi(previous?.kpi, kpiStatuses, checkedAt, {
        command_acceptance:
          kpiStatuses.command_acceptance === "ok"
            ? undefined
            : "gateway or queue health degraded",
        task_execution:
          kpiStatuses.task_execution === "ok"
            ? undefined
            : "supervisor or lease health degraded",
      }),
      long_running: await this.buildLongRunHealthSnapshot(checkedAt),
      details: await this.buildHealthDetails(phase),
    });
  }

  async acquireLeadership(leaseMs: number, heartbeatMs: number): Promise<void> {
    if (!this.deps.leaderLockManager) {
      return;
    }

    const acquired = await this.deps.leaderLockManager.acquire({ leaseMs });
    if (!acquired) {
      const current = await this.deps.leaderLockManager.read();
      throw new Error(
        `Runtime daemon leader already active (PID ${current?.pid ?? "unknown"})`
      );
    }

    this.leaderOwnerToken = acquired.owner_token;
    await this.writeRuntimeHeartbeat();
    this.leaderHeartbeatTimer = setInterval(() => {
      void this.renewLeadership(leaseMs).catch((err) => {
        this.deps.logger.error("Failed to renew runtime leader lock", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.deps.onLeadershipLost(
          err instanceof Error ? err.message : String(err)
        );
      });
    }, heartbeatMs);
    this.leaderHeartbeatTimer.unref?.();
  }

  async releaseLeadership(): Promise<void> {
    if (this.leaderHeartbeatTimer !== null) {
      clearInterval(this.leaderHeartbeatTimer);
      this.leaderHeartbeatTimer = null;
    }

    const ownerToken = this.leaderOwnerToken;
    this.leaderOwnerToken = null;
    if (ownerToken) {
      await this.deps.leaderLockManager?.release(ownerToken);
    }
  }

  async saveFinalHealth(status: "failed" | "degraded"): Promise<void> {
    const checkedAt = Date.now();
    const previous = await this.deps.runtimeHealthStore?.loadDaemonHealth();
    await this.deps.runtimeHealthStore?.saveDaemonHealth({
      status,
      leader: false,
      checked_at: checkedAt,
      kpi: evolveRuntimeHealthKpi(previous?.kpi, {
        process_alive: status,
        command_acceptance: status,
        task_execution: status,
      }, checkedAt, {
        process_alive:
          status === "failed" ? "daemon exited unexpectedly" : "daemon stopped",
        command_acceptance:
          status === "failed" ? "daemon exited unexpectedly" : "daemon stopped",
        task_execution:
          status === "failed" ? "daemon exited unexpectedly" : "daemon stopped",
      }),
      long_running: previous?.long_running
        ? buildLongRunHealth({
            ...previous.long_running.signals,
            process: {
              ...previous.long_running.signals.process,
              status: "dead",
              checked_at: checkedAt,
              observed_at: checkedAt,
              reason: status === "failed" ? "daemon exited unexpectedly" : "daemon stopped",
            },
            resumable: status !== "failed",
          }, checkedAt)
        : undefined,
      details: await this.buildHealthDetails(this.runtimeHealthPhase),
    });
  }

  private async renewLeadership(leaseMs: number): Promise<void> {
    if (!this.deps.leaderLockManager || !this.leaderOwnerToken) {
      return;
    }

    const renewed = await this.deps.leaderLockManager.renew(this.leaderOwnerToken, {
      leaseMs,
    });
    if (!renewed) {
      this.deps.onLeadershipLost("Runtime leader lock was lost");
      return;
    }

    await this.writeRuntimeHeartbeat();
  }

  private async writeRuntimeHeartbeat(): Promise<void> {
    if (!this.deps.runtimeHealthStore) {
      return;
    }

    const checkedAt = Date.now();
    const components =
      this.runtimeHealthComponents ??
      {
        gateway: "degraded" as const,
        queue: "degraded" as const,
        leases: "degraded" as const,
        approval: "degraded" as const,
        outbox: "degraded" as const,
          supervisor: "degraded" as const,
      };
    const status = Object.values(components).every((value) => value === "ok") ? "ok" : "degraded";
    const previous = await this.deps.runtimeHealthStore.loadDaemonHealth();
    const derivedStatuses = this.deriveCapabilityStatuses(components);
    await this.saveDaemonHealthWithKpi({
      status,
      checkedAt,
      capabilityStatuses: {
        process_alive: "ok",
        command_acceptance: this.mergeCapabilityStatus(
          previous?.kpi?.command_acceptance.status,
          derivedStatuses.command_acceptance,
        ),
        task_execution: this.mergeCapabilityStatus(
          previous?.kpi?.task_execution.status,
          derivedStatuses.task_execution,
        ),
      },
      reasons: {
        command_acceptance:
          components.gateway === "ok" && components.queue === "ok"
            ? undefined
            : "gateway or queue health degraded",
        task_execution:
          components.supervisor === "ok" && components.leases === "ok"
            ? undefined
            : "supervisor or lease health degraded",
      },
    });
  }

  async observeCommandAcceptance(
    status: Exclude<RuntimeHealthCapabilityStatuses["command_acceptance"], "failed"> | "failed",
    reason?: string
  ): Promise<void> {
    const components = this.runtimeHealthComponents;
    const derivedStatuses = components ? this.deriveCapabilityStatuses(components) : null;
    await this.saveDaemonHealthWithKpi({
      status: status === "failed" ? "failed" : this.summarizeComponents(components),
      checkedAt: Date.now(),
      capabilityStatuses: {
        process_alive: "ok",
        command_acceptance: status,
        task_execution: derivedStatuses?.task_execution ?? "degraded",
      },
      reasons: {
        command_acceptance: reason,
      },
    });
  }

  async observeTaskExecution(
    status: Exclude<RuntimeHealthCapabilityStatuses["task_execution"], "failed"> | "failed",
    reason?: string
  ): Promise<void> {
    const components = this.runtimeHealthComponents;
    const derivedStatuses = components ? this.deriveCapabilityStatuses(components) : null;
    await this.saveDaemonHealthWithKpi({
      status: status === "failed" ? "failed" : this.summarizeComponents(components),
      checkedAt: Date.now(),
      capabilityStatuses: {
        process_alive: "ok",
        command_acceptance: derivedStatuses?.command_acceptance ?? "degraded",
        task_execution: status,
      },
      reasons: {
        task_execution: reason,
      },
    });
  }
}
