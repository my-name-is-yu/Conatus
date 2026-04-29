import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ApprovalRequiredEvent } from "../approval-broker.js";
import type { OutboxStore } from "../store/index.js";
import { BrowserSessionStore } from "../interactive-automation/index.js";
import { GuardrailStore } from "../guardrails/index.js";

type ActiveWorkersProvider = () =>
  | Array<Record<string, unknown>>
  | Promise<Array<Record<string, unknown>>>;

export interface EventServerSnapshotData {
  daemon: Record<string, unknown> | null;
  goals: Array<{ id: string; title: string; status: string; loop_status: string }>;
  approvals: ApprovalRequiredEvent[];
  active_workers: Array<Record<string, unknown>>;
  last_outbox_seq: number;
  auth_sessions: Array<Record<string, unknown>>;
  guardrails: Record<string, unknown> | null;
}

export class EventServerSnapshotReader {
  constructor(private readonly eventsDir: string) {}

  async buildSnapshot(
    approvalEvents: ApprovalRequiredEvent[],
    outboxStore?: OutboxStore,
    activeWorkersProvider?: ActiveWorkersProvider
  ): Promise<EventServerSnapshotData> {
    const [daemon, goals, latestOutbox, activeWorkers, authSessions, guardrails] = await Promise.all([
      this.readDaemonState(),
      this.readGoalSummaries(),
      outboxStore?.loadLatest() ?? Promise.resolve(null),
      activeWorkersProvider?.() ?? Promise.resolve([]),
      this.readPendingAuthSessions(),
      this.readGuardrailSnapshot(),
    ]);

    return {
      daemon,
      goals,
      approvals: approvalEvents,
      active_workers: activeWorkers,
      last_outbox_seq: latestOutbox?.seq ?? 0,
      auth_sessions: authSessions,
      guardrails,
    };
  }

  private runtimeRoot(): string {
    return path.join(path.dirname(this.eventsDir), "runtime");
  }

  private async readPendingAuthSessions(): Promise<Array<Record<string, unknown>>> {
    const store = new BrowserSessionStore(this.runtimeRoot());
    const sessions = await store.listPendingAuth();
    return sessions.map((session) => ({
      session_id: session.session_id,
      provider_id: session.provider_id,
      service_key: session.service_key,
      workspace: session.workspace,
      actor_key: session.actor_key,
      state: session.state,
      updated_at: session.updated_at,
    }));
  }

  private async readGuardrailSnapshot(): Promise<Record<string, unknown> | null> {
    const store = new GuardrailStore(this.runtimeRoot());
    const [breakers, backpressure] = await Promise.all([
      store.listBreakers(),
      store.loadBackpressureSnapshot(),
    ]);
    const openBreakers = breakers
      .filter((breaker) => breaker.state === "open" || breaker.state === "paused" || breaker.state === "half_open")
      .map((breaker) => ({
        key: breaker.key,
        provider_id: breaker.provider_id,
        service_key: breaker.service_key,
        state: breaker.state,
        failure_count: breaker.failure_count,
        cooldown_until: breaker.cooldown_until ?? null,
        updated_at: breaker.updated_at,
      }));
    return {
      open_breakers: openBreakers,
      backpressure_active: backpressure?.active ?? [],
      backpressure_throttled: backpressure?.throttled ?? [],
    };
  }

  async readDaemonStateRaw(): Promise<string | null> {
    const statePath = path.join(this.eventsDir.replace("/events", ""), "daemon-state.json");
    try {
      return await fsp.readFile(statePath, "utf-8");
    } catch {
      return null;
    }
  }

  async readDaemonState(): Promise<Record<string, unknown> | null> {
    const raw = await this.readDaemonStateRaw();
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async readGoalSummaries(): Promise<Array<{ id: string; title: string; status: string; loop_status: string }>> {
    const goalsDir = path.join(path.dirname(this.eventsDir), "goals");
    let entries: string[];
    try {
      entries = await fsp.readdir(goalsDir);
    } catch {
      return [];
    }

    const goals: Array<{ id: string; title: string; status: string; loop_status: string }> = [];
    for (const entry of entries) {
      const goalFile = path.join(goalsDir, entry, "goal.json");
      try {
        const content = await fsp.readFile(goalFile, "utf-8");
        const raw = JSON.parse(content) as Record<string, unknown>;
        goals.push({
          id: String(raw["id"] ?? entry),
          title: String(raw["title"] ?? ""),
          status: String(raw["status"] ?? "active"),
          loop_status: String(raw["loop_status"] ?? "idle"),
        });
      } catch {
        // Skip unreadable entries.
      }
    }
    return goals;
  }

  async readGoalDetail(goalId: string): Promise<Record<string, unknown> | null> {
    const goalFile = path.join(path.dirname(this.eventsDir), "goals", goalId, "goal.json");
    let goalRaw: Record<string, unknown>;
    try {
      const content = await fsp.readFile(goalFile, "utf-8");
      goalRaw = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return null;
    }

    const gapFile = path.join(path.dirname(this.eventsDir), "goals", goalId, "gap-history.json");
    let currentGap: unknown = null;
    try {
      const gapContent = await fsp.readFile(gapFile, "utf-8");
      const gapHistory = JSON.parse(gapContent) as unknown[];
      currentGap = gapHistory.at(-1) ?? null;
    } catch {
      // Gap file may not exist.
    }

    return { ...goalRaw, current_gap: currentGap };
  }
}
