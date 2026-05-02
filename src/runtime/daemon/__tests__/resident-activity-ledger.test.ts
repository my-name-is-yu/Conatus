import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { DaemonConfigSchema, DaemonStateSchema } from "../../types/daemon.js";
import { ProactiveInterventionStore } from "../../store/proactive-intervention-store.js";
import { persistResidentActivity } from "../runner-resident-shared.js";

describe("persistResidentActivity proactive intervention ledger", () => {
  let baseDir: string;

  afterEach(() => {
    cleanupTempDir(baseDir);
  });

  it("keeps latest daemon state and appends resident activity history", async () => {
    baseDir = makeTempDir("pulseed-resident-activity-");
    const state = DaemonStateSchema.parse({
      pid: 123,
      started_at: "2026-05-02T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "idle" as const,
      crash_count: 0,
      last_error: null,
    });

    await persistResidentActivity({
      baseDir,
      config: DaemonConfigSchema.parse({ runtime_root: "runtime" }),
      state,
      saveDaemonState: vi.fn().mockResolvedValue(undefined),
      logger: { warn: vi.fn() } as never,
    }, {
      intervention_id: "resident-intervention-1",
      kind: "suggestion",
      trigger: "proactive_tick",
      summary: "Resident suggested a follow-up.",
      recorded_at: "2026-05-02T00:01:00.000Z",
    });

    expect(state.resident_activity?.intervention_id).toBe("resident-intervention-1");
    const events = await new ProactiveInterventionStore(`${baseDir}/runtime`).list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "intervention",
      intervention_id: "resident-intervention-1",
    });
  });
});
