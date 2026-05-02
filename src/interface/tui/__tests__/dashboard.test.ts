import { describe, expect, it } from "vitest";
import { buildOperatorConsoleModel, buildWorkDashboardRows } from "../dashboard.js";
import type {
  BackgroundRun,
  RuntimeSession,
  RuntimeSessionRegistrySnapshot,
} from "../../../runtime/session-registry/types.js";
import type { RuntimeEvidenceSummary } from "../../../runtime/store/evidence-ledger.js";
import type { RuntimeHealthSnapshot } from "../../../runtime/store/runtime-schemas.js";

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

function health(overrides: Partial<RuntimeHealthSnapshot["long_running"]> = {}): RuntimeHealthSnapshot {
  const checkedAt = NOW.getTime();
  return {
    status: "ok",
    leader: true,
    checked_at: checkedAt,
    components: {
      gateway: "ok",
      queue: "ok",
      leases: "ok",
      approval: "ok",
      outbox: "ok",
      supervisor: "ok",
    },
    long_running: {
      summary: "alive_and_progressing",
      checked_at: checkedAt,
      signals: {
        process: { status: "alive", checked_at: checkedAt },
        child_activity: { status: "active", active_count: 1, checked_at: checkedAt },
        log_freshness: { status: "fresh", checked_at: checkedAt },
        artifact_freshness: { status: "fresh", checked_at: checkedAt },
        metric_freshness: { status: "fresh", metric_name: "score", checked_at: checkedAt },
        metric_progress: { status: "improved", metric_name: "score", previous_value: 0.8, current_value: 0.84, checked_at: checkedAt },
        blocker: { status: "none", checked_at: checkedAt },
      },
      ...overrides,
    },
  };
}

function evidenceSummary(overrides: Partial<RuntimeEvidenceSummary> = {}): RuntimeEvidenceSummary {
  return {
    schema_version: "runtime-evidence-summary-v1",
    context_policy_version: "quarantine-filtered-planning-context-v2",
    generated_at: NOW.toISOString(),
    scope: { run_id: "run-1" },
    total_entries: 1,
    latest_strategy: null,
    best_evidence: null,
    metric_trends: [],
    evaluator_summary: {
      local_best: null,
      external_best: null,
      gap: null,
      budgets: [],
      calibration: [],
      approval_required_actions: [],
      observations: [],
    },
    research_memos: [],
    dream_checkpoints: [],
    divergent_exploration: [],
    corrections: [],
    correction_state: {},
    candidate_lineages: [],
    recommended_candidate_portfolio: [],
    candidate_selection_summary: {
      primary_metric: null,
      raw_best: null,
      robust_best: null,
      ranked: [],
      final_portfolio: {
        safe: null,
        aggressive: null,
        diverse: null,
      },
    },
    near_miss_candidates: [],
    artifact_retention: {
      schema_version: "runtime-artifact-retention-summary-v1",
      total_artifacts: 0,
      total_size_bytes: 0,
      unknown_size_count: 0,
      protected_count: 0,
      by_retention_class: {
        final_deliverable: 0,
        best_candidate: 0,
        robust_candidate: 0,
        near_miss: 0,
        reproducibility_critical: 0,
        evidence_report: 0,
        low_value_smoke: 0,
        cache_intermediate: 0,
        duplicate_superseded: 0,
        other: 0,
      },
      cleanup_plan: {
        mode: "plan_only",
        destructive_actions_default: "approval_required",
        actions: [],
      },
    },
    recent_failed_attempts: [],
    failed_lineages: [],
    recent_entries: [],
    warnings: [],
    ...overrides,
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

  it("does not mark sessions as attention-needed from title keywords alone", () => {
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
        attention: false,
      },
    ]);
  });

  it("marks runs as attention-needed from structured approval evidence", () => {
    const rows = buildWorkDashboardRows(snapshot({
      background_runs: [run({
        id: "run-approval",
        summary: "提出前に人間の確認が必要です",
      })],
    }), NOW, {
      "run-approval": evidenceSummary({
        evaluator_summary: {
          ...evidenceSummary().evaluator_summary,
          approval_required_actions: [{
            id: "submit-final",
            label: "Approve final submission",
            approval_required: true,
            status: "approval_required",
            entry_id: "entry-1",
            evaluator_id: "kaggle",
            signal: "external",
            source: "submit",
            candidate_id: "candidate-1",
            observed_at: NOW.toISOString(),
          }],
        },
      }),
    });

    expect(rows).toMatchObject([
      {
        id: "run-approval",
        group: "active",
        attention: true,
      },
    ]);
  });

  it("does not derive run attention from non-English free-text summary or error", () => {
    const rows = buildWorkDashboardRows(snapshot({
      background_runs: [run({
        id: "run-localized",
        summary: "承認待ちです",
        error: "ブロックされています",
      })],
    }), NOW);

    expect(rows).toMatchObject([
      {
        id: "run-localized",
        group: "active",
        attention: false,
      },
    ]);
  });
});

describe("buildOperatorConsoleModel", () => {
  it("separates liveness from metric useful progress for active sessions", () => {
    const model = buildOperatorConsoleModel(snapshot({
      background_runs: [run({ id: "run-active" })],
    }), health(), {
      "run-active": evidenceSummary(),
    }, NOW);

    expect(model).toMatchObject({
      selectedId: "run-active",
      lifecycle: "running",
      liveness: expect.stringContaining("alive"),
      usefulProgress: expect.stringContaining("improved"),
    });
  });

  it("shows stale sessions as stale rather than active", () => {
    const model = buildOperatorConsoleModel(snapshot({
      sessions: [session({
        id: "session-stale",
        last_event_at: "2026-05-01T21:00:00.000Z",
        updated_at: "2026-05-01T21:00:00.000Z",
      })],
    }), null, {}, NOW);

    expect(model).toMatchObject({
      selectedId: "session-stale",
      lifecycle: "stale",
      liveness: "stale catalog heartbeat",
      blockers: ["stale catalog state"],
    });
  });

  it("shows blocked approval state distinctly", () => {
    const model = buildOperatorConsoleModel(snapshot({
      background_runs: [run({
        id: "run-approval",
        summary: "提出前に確認が必要です",
      })],
    }), health({
      summary: "alive_but_waiting",
      signals: {
        ...health().long_running!.signals,
        blocker: { status: "approval_wait", reason: "submit needs operator approval", checked_at: NOW.getTime() },
      },
    }), {
      "run-approval": evidenceSummary({
        evaluator_summary: {
          ...evidenceSummary().evaluator_summary,
          approval_required_actions: [{
            id: "submit-final",
            label: "Approve final submission",
            approval_required: true,
            status: "approval_required",
            entry_id: "entry-1",
            evaluator_id: "kaggle",
            signal: "external",
            source: "submit",
            candidate_id: "candidate-1",
            observed_at: NOW.toISOString(),
          }],
        },
      }),
    }, NOW);

    expect(model).toMatchObject({
      lifecycle: "approval-required",
      blockers: expect.arrayContaining([
        "Approve final submission",
      ]),
    });
  });

  it("shows structured blocked state without using summary keywords", () => {
    const model = buildOperatorConsoleModel(snapshot({
      background_runs: [run({
        id: "run-blocked",
        summary: "外部評価の結果待ちです",
      })],
    }), null, {
      "run-blocked": evidenceSummary({
        evaluator_summary: {
          ...evidenceSummary().evaluator_summary,
          gap: {
            kind: "pending_external",
            summary: "external evaluator has not returned a confirmed result",
          },
        },
      }),
    }, NOW);

    expect(model).toMatchObject({
      lifecycle: "blocked",
      blockers: expect.arrayContaining([
        "external evaluator has not returned a confirmed result",
      ]),
    });
  });

  it("keeps non-English run summaries display-only when structured state is missing", () => {
    const model = buildOperatorConsoleModel(snapshot({
      background_runs: [run({
        id: "run-localized",
        summary: "承認待ちです",
        error: "ブロックされています",
      })],
    }), null, {}, NOW);

    expect(model).toMatchObject({
      lifecycle: "running",
      blockers: ["No blockers detected."],
      latestEvents: expect.arrayContaining(["承認待ちです", "ブロックされています"]),
    });
  });

  it("uses typed phase metadata instead of strategy text for mode labels", () => {
    const model = buildOperatorConsoleModel(snapshot({
      background_runs: [run({ id: "run-phase" })],
    }), null, {
      "run-phase": evidenceSummary({
        latest_strategy: {
          schema_version: "runtime-evidence-entry-v1",
          id: "strategy-1",
          occurred_at: NOW.toISOString(),
          kind: "strategy",
          scope: { run_id: "run-phase" },
          strategy: "finalization candidate with final portfolio language",
          metrics: [],
          artifacts: [],
          raw_refs: [],
        },
        evaluator_summary: {
          ...evidenceSummary().evaluator_summary,
          budgets: [{
            evaluator_id: "kaggle",
            source: "local",
            remaining_attempts: 2,
            approval_required: true,
            phase: "exploration",
            diversified_portfolio_required: false,
            reserve_for_finalization: false,
            observed_at: NOW.toISOString(),
          }],
        },
      }),
    }, NOW);

    expect(model?.currentMode).toBe("exploration");
  });

  it("does not apply daemon aggregate health as selected-run lifecycle or progress", () => {
    const model = buildOperatorConsoleModel(snapshot({
      background_runs: [run({
        id: "run-complete",
        status: "succeeded",
        completed_at: "2026-05-01T23:50:00.000Z",
        updated_at: "2026-05-01T23:50:00.000Z",
      })],
    }), health({
      summary: "alive_but_waiting",
      signals: {
        ...health().long_running!.signals,
        metric_progress: { status: "improved", metric_name: "global_score", current_value: 0.99, checked_at: NOW.getTime() },
        blocker: { status: "approval_wait", reason: "unrelated run approval", checked_at: NOW.getTime() },
      },
    }), {
      "run-complete": evidenceSummary({
        metric_trends: [{
          metric_key: "selected_score",
          direction: "maximize",
          trend: "stalled",
          latest_value: 0.72,
          latest_observed_at: NOW.toISOString(),
          best_value: 0.72,
          best_observed_at: NOW.toISOString(),
          observation_count: 4,
          recent_slope_per_observation: 0,
          best_delta: 0,
          last_meaningful_improvement_delta: null,
          last_breakthrough_delta: null,
          time_since_last_meaningful_improvement_ms: null,
          improvement_threshold: 0.01,
          breakthrough_threshold: 0.05,
          noise_band: 0.005,
          confidence: 1,
          source_refs: [],
          summary: "stalled",
        }],
      }),
    }, NOW);

    expect(model).toMatchObject({
      lifecycle: "completed",
      usefulProgress: "selected_score stalled; latest 0.72; best 0.72",
      blockers: ["No blockers detected."],
    });
  });

  it("does not attribute daemon aggregate approval waits to an active selected run", () => {
    const model = buildOperatorConsoleModel(snapshot({
      background_runs: [run({ id: "run-active" })],
    }), health({
      summary: "alive_but_waiting",
      signals: {
        ...health().long_running!.signals,
        blocker: { status: "approval_wait", reason: "unrelated run approval", checked_at: NOW.getTime() },
      },
    }), {}, NOW);

    expect(model).toMatchObject({
      lifecycle: "running",
      blockers: ["No blockers detected."],
    });
  });

  it("shows metric progress from evidence when health metric progress is missing", () => {
    const model = buildOperatorConsoleModel(snapshot({
      background_runs: [run({ id: "run-metric" })],
    }), null, {
      "run-metric": evidenceSummary({
        metric_trends: [{
          metric_key: "balanced_accuracy",
          direction: "maximize",
          trend: "breakthrough",
          latest_value: 0.91,
          latest_observed_at: NOW.toISOString(),
          best_value: 0.91,
          best_observed_at: NOW.toISOString(),
          observation_count: 3,
          recent_slope_per_observation: 0.02,
          best_delta: 0.06,
          last_meaningful_improvement_delta: 0.06,
          last_breakthrough_delta: 0.06,
          time_since_last_meaningful_improvement_ms: 0,
          improvement_threshold: 0.01,
          breakthrough_threshold: 0.05,
          noise_band: 0.005,
          confidence: 1,
          source_refs: [],
          summary: "breakthrough",
        }],
      }),
    }, NOW);

    expect(model?.usefulProgress).toBe("balanced_accuracy breakthrough; latest 0.91; best 0.91");
    expect(model?.metrics).toContain("balanced_accuracy: latest 0.91, best 0.91, breakthrough");
  });

  it("shows completed session displays", () => {
    const model = buildOperatorConsoleModel(snapshot({
      background_runs: [run({
        id: "run-complete",
        status: "succeeded",
        completed_at: "2026-05-01T23:50:00.000Z",
        updated_at: "2026-05-01T23:50:00.000Z",
        artifacts: [{ label: "report", path: "/repo/report.md", url: null, kind: "report" }],
      })],
    }), null, {}, NOW);

    expect(model).toMatchObject({
      lifecycle: "completed",
      artifacts: expect.arrayContaining(["report: /repo/report.md"]),
    });
  });

  it("shows failed session displays", () => {
    const model = buildOperatorConsoleModel(snapshot({
      background_runs: [run({
        id: "run-failed",
        status: "failed",
        completed_at: "2026-05-01T23:50:00.000Z",
        updated_at: "2026-05-01T23:50:00.000Z",
        error: "training crashed",
      })],
    }), null, {}, NOW);

    expect(model).toMatchObject({
      lifecycle: "failed",
      blockers: expect.arrayContaining(["training crashed"]),
      latestEvents: expect.arrayContaining(["training crashed"]),
    });
  });
});
