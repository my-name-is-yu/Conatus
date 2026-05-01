import { describe, expect, it } from "vitest";
import type { Goal } from "../../../base/types/goal.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";
import {
  buildDeadlineFinalizationStatus,
  shouldStopExplorationForFinalization,
} from "../deadline-finalization.js";

const NOW = new Date("2026-04-30T00:00:00.000Z");

function deadlineIn(ms: number): string {
  return new Date(NOW.getTime() + ms).toISOString();
}

function finalizationPolicy(
  overrides: Partial<NonNullable<Goal["finalization_policy"]>> = {}
): NonNullable<Goal["finalization_policy"]> {
  return {
    minimum_buffer_ms: 30 * 60_000,
    consolidation_buffer_ms: 0,
    best_artifact_selection: "best_evidence" as const,
    require_reproducibility_manifest: false,
    verification_steps: [],
    external_actions: [],
    ...overrides,
  };
}

describe("deadline finalization planning", () => {
  it("returns no_deadline when the goal has no deadline", () => {
    const status = buildDeadlineFinalizationStatus({
      goal: makeGoal({ deadline: null }),
      now: NOW,
    });

    expect(status.mode).toBe("no_deadline");
    expect(status.remaining_exploration_ms).toBeNull();
    expect(status.finalization_plan).toBeNull();
    expect(shouldStopExplorationForFinalization(status)).toBe(false);
  });

  it("keeps exploration open when the deadline is far beyond the reserved buffer", () => {
    const status = buildDeadlineFinalizationStatus({
      goal: makeGoal({
        deadline: deadlineIn(120 * 60_000),
        finalization_policy: finalizationPolicy({
          consolidation_buffer_ms: 15 * 60_000,
        }),
      }),
      now: NOW,
    });

    expect(status.mode).toBe("exploration");
    expect(status.remaining_exploration_ms).toBe(90 * 60_000);
    expect(shouldStopExplorationForFinalization(status)).toBe(false);
  });

  it("enters consolidation before the finalization buffer is reached", () => {
    const status = buildDeadlineFinalizationStatus({
      goal: makeGoal({
        deadline: deadlineIn(40 * 60_000),
        finalization_policy: finalizationPolicy({
          consolidation_buffer_ms: 15 * 60_000,
        }),
      }),
      now: NOW,
    });

    expect(status.mode).toBe("consolidation");
    expect(status.remaining_exploration_ms).toBe(10 * 60_000);
    expect(shouldStopExplorationForFinalization(status)).toBe(false);
  });

  it("enters finalization when the reserved buffer threshold is reached", () => {
    const status = buildDeadlineFinalizationStatus({
      goal: makeGoal({
        deadline: deadlineIn(25 * 60_000),
        finalization_policy: finalizationPolicy({
          deliverable_contract: "Final report ready for handoff",
          verification_steps: ["Run smoke test", "Confirm artifact path"],
        }),
      }),
      now: NOW,
      bestArtifact: {
        id: "artifact-1",
        label: "best-report.md",
        source: "runtime_evidence_ledger",
      },
    });

    expect(status.mode).toBe("finalization");
    expect(status.finalization_plan).toMatchObject({
      deliverable_contract: "Final report ready for handoff",
      best_artifact: { label: "best-report.md" },
      reproducibility_manifest: {
        required: false,
        status: "not_required",
      },
      verification_steps: ["Run smoke test", "Confirm artifact path"],
    });
    expect(shouldStopExplorationForFinalization(status)).toBe(true);
  });

  it("marks a missed deadline as handoff-only finalization", () => {
    const status = buildDeadlineFinalizationStatus({
      goal: makeGoal({
        deadline: deadlineIn(-1_000),
        finalization_policy: finalizationPolicy(),
      }),
      now: NOW,
    });

    expect(status.mode).toBe("missed_deadline");
    expect(status.remaining_ms).toBe(-1_000);
    expect(shouldStopExplorationForFinalization(status)).toBe(true);
  });

  it("keeps external final actions approval-gated", () => {
    const status = buildDeadlineFinalizationStatus({
      goal: makeGoal({
        deadline: deadlineIn(10 * 60_000),
        finalization_policy: finalizationPolicy({
          external_actions: [
            {
              id: "submit",
              label: "Submit final artifact",
              tool_name: "external_submit",
              payload_ref: "artifact:best",
              approval_required: true,
            },
          ],
        }),
      }),
      now: NOW,
    });

    expect(status.finalization_plan?.approval_required_actions).toEqual([
      {
        id: "submit",
        label: "Submit final artifact",
        tool_name: "external_submit",
        payload_ref: "artifact:best",
        approval_required: true,
      },
    ]);
    expect(status.finalization_plan?.handoff_required).toBe(true);
  });

  it("can require a reproducibility manifest before final delivery", () => {
    const missing = buildDeadlineFinalizationStatus({
      goal: makeGoal({
        deadline: deadlineIn(10 * 60_000),
        finalization_policy: finalizationPolicy({
          require_reproducibility_manifest: true,
        }),
      }),
      now: NOW,
    });

    expect(missing.finalization_plan?.reproducibility_manifest).toMatchObject({
      required: true,
      status: "required_missing",
    });
    expect(missing.finalization_plan?.handoff_required).toBe(true);

    const ready = buildDeadlineFinalizationStatus({
      goal: makeGoal({
        deadline: deadlineIn(10 * 60_000),
        finalization_policy: finalizationPolicy({
          require_reproducibility_manifest: true,
        }),
      }),
      now: NOW,
      reproducibilityManifestId: "candidate:run:final:candidate-a",
    });

    expect(ready.finalization_plan?.reproducibility_manifest).toMatchObject({
      required: true,
      status: "ready",
      manifest_id: "candidate:run:final:candidate-a",
    });
    expect(ready.finalization_plan?.handoff_required).toBe(false);
  });
});
