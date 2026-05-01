import { describe, expect, it } from "vitest";
import { buildWorkDashboardRows } from "../dashboard.js";
import type {
  BackgroundRun,
  RuntimeSession,
  RuntimeSessionRegistrySnapshot,
} from "../../../runtime/session-registry/types.js";

const NOW = new Date("2026-05-02T00:00:00.000Z");

function session(overrides: Partial<RuntimeSession>): RuntimeSession {
  return {
    schema_version: "runtime-session-v1",
    id: "session-1",
    kind: "agent",
    parent_session_id: null,
    title: "Agent session",
    workspace: "/repo",
    status: "active",
    created_at: "2026-05-01T23:00:00.000Z",
    updated_at: "2026-05-01T23:55:00.000Z",
    last_event_at: "2026-05-01T23:55:00.000Z",
    transcript_ref: null,
    state_ref: null,
    reply_target: null,
    resumable: true,
    attachable: true,
    source_refs: [],
    ...overrides,
  };
}

function run(overrides: Partial<BackgroundRun>): BackgroundRun {
  return {
    schema_version: "background-run-v1",
    id: "run-1",
    kind: "coreloop_run",
    parent_session_id: null,
    child_session_id: null,
    process_session_id: null,
    status: "running",
    notify_policy: "done_only",
    reply_target_source: "none",
    pinned_reply_target: null,
    title: "Benchmark run",
    workspace: "/repo",
    created_at: "2026-05-01T23:00:00.000Z",
    started_at: "2026-05-01T23:30:00.000Z",
    updated_at: "2026-05-01T23:58:00.000Z",
    completed_at: null,
    summary: null,
    error: null,
    artifacts: [],
    source_refs: [],
    ...overrides,
  };
}

function snapshot(params: {
  sessions?: RuntimeSession[];
  background_runs?: BackgroundRun[];
}): RuntimeSessionRegistrySnapshot {
  return {
    schema_version: "runtime-session-registry-v1",
    generated_at: NOW.toISOString(),
    sessions: params.sessions ?? [],
    background_runs: params.background_runs ?? [],
    warnings: [],
  };
}

describe("buildWorkDashboardRows", () => {
  it("shows active sessions and running runs as active work", () => {
    const rows = buildWorkDashboardRows(snapshot({
      sessions: [session({ id: "session-active" })],
      background_runs: [run({ id: "run-active" })],
    }), NOW);

    expect(rows.map((row) => [row.id, row.group, row.attention])).toEqual([
      ["run-active", "active", false],
      ["session-active", "active", false],
    ]);
  });

  it("shows recently completed runs as recent work", () => {
    const rows = buildWorkDashboardRows(snapshot({
      background_runs: [run({
        id: "run-done",
        status: "succeeded",
        completed_at: "2026-05-01T23:50:00.000Z",
        updated_at: "2026-05-01T23:50:00.000Z",
      })],
    }), NOW);

    expect(rows).toMatchObject([
      {
        id: "run-done",
        group: "recent",
        attention: false,
      },
    ]);
  });

  it("does not show stale current sessions as active work", () => {
    const rows = buildWorkDashboardRows(snapshot({
      sessions: [session({
        id: "session-stale",
        status: "active",
        last_event_at: "2026-05-01T21:00:00.000Z",
        updated_at: "2026-05-01T21:00:00.000Z",
      })],
    }), NOW);

    expect(rows).toMatchObject([
      {
        id: "session-stale",
        group: "recent",
        status: "stale",
        attention: true,
      },
    ]);
  });

  it("marks attention-needed run states separately from normal work", () => {
    const rows = buildWorkDashboardRows(snapshot({
      background_runs: [run({
        id: "run-failed",
        status: "failed",
        completed_at: "2026-05-01T23:40:00.000Z",
        updated_at: "2026-05-01T23:40:00.000Z",
        error: "approval-required before submit",
      })],
    }), NOW);

    expect(rows).toMatchObject([
      {
        id: "run-failed",
        group: "recent",
        attention: true,
        summary: "approval-required before submit",
      },
    ]);
  });

  it("marks waiting blocked and approval-required sessions as attention-needed", () => {
    const rows = buildWorkDashboardRows(snapshot({
      sessions: [session({
        id: "session-waiting-approval",
        title: "Waiting for approval-required submit",
        status: "active",
      })],
    }), NOW);

    expect(rows).toMatchObject([
      {
        id: "session-waiting-approval",
        group: "active",
        attention: true,
      },
    ]);
  });
});
