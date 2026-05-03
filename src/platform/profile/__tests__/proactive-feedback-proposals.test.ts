import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DaemonConfigSchema, DaemonStateSchema } from "../../../runtime/types/daemon.js";
import { runProactiveMaintenance } from "../../../runtime/daemon/maintenance.js";
import { ProactiveInterventionStore } from "../../../runtime/store/proactive-intervention-store.js";
import { rejectRelationshipProfileChangeProposal } from "../profile-change-proposal.js";
import { loadRelationshipProfile } from "../relationship-profile.js";
import { createRelationshipProfileProposalsFromProactiveFeedback } from "../proactive-feedback-proposals.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-proactive-feedback-proposals-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("proactive feedback relationship profile proposals", () => {
  it("creates reduce-frequency and confirmation proposals from typed feedback outcomes", async () => {
    const baseDir = makeTempDir();
    const store = new ProactiveInterventionStore(baseDir);

    const overreach = await store.appendFeedback({
      interventionId: "intervention-overreach",
      outcome: "overreach",
      overreachIndicators: ["too_frequent"],
      reason: "Too many proactive suggestions.",
      recordedAt: "2026-05-03T00:00:00.000Z",
    });
    const corrected = await store.appendFeedback({
      interventionId: "intervention-corrected",
      outcome: "corrected",
      reason: "The suggestion needed confirmation first.",
      recordedAt: "2026-05-03T00:01:00.000Z",
    });

    const overreachResult = await createRelationshipProfileProposalsFromProactiveFeedback(baseDir, overreach);
    const correctedResult = await createRelationshipProfileProposalsFromProactiveFeedback(baseDir, corrected);

    expect(overreachResult.proposals[0]).toMatchObject({
      source: "proactive_feedback",
      approval_state: "pending",
      proposed_item: {
        stable_key: "user.intervention.proactivity",
        kind: "intervention_policy",
        value: "Reduce the frequency of non-urgent proactive interventions and prefer fewer, higher-confidence suggestions.",
        allowed_scopes: ["resident_behavior", "user_facing_review"],
      },
      consent_scopes: ["user_facing_review"],
      evidence_refs: [
        `proactive-intervention:event:${overreach.event_id}`,
        "proactive-intervention:intervention:intervention-overreach",
      ],
    });
    expect(correctedResult.proposals[0]?.proposed_item).toMatchObject({
      stable_key: "user.intervention.correction_policy",
      kind: "intervention_policy",
      value: "Ask for confirmation before acting on non-urgent proactive suggestions.",
    });
  });

  it("creates governed candidates for ignored, dismissed, and accepted successful outcomes", async () => {
    const baseDir = makeTempDir();
    const store = new ProactiveInterventionStore(baseDir);
    const ignored = await store.appendFeedback({
      interventionId: "intervention-ignored",
      outcome: "ignored",
      recordedAt: "2026-05-03T00:00:00.000Z",
    });
    const dismissed = await store.appendFeedback({
      interventionId: "intervention-dismissed",
      outcome: "dismissed",
      recordedAt: "2026-05-03T00:01:00.000Z",
    });
    const accepted = await store.appendFeedback({
      interventionId: "intervention-accepted",
      outcome: "accepted",
      followThroughSuccess: true,
      recordedAt: "2026-05-03T00:02:00.000Z",
    });

    const proposals = [
      ...(await createRelationshipProfileProposalsFromProactiveFeedback(baseDir, ignored)).proposals,
      ...(await createRelationshipProfileProposalsFromProactiveFeedback(baseDir, dismissed)).proposals,
      ...(await createRelationshipProfileProposalsFromProactiveFeedback(baseDir, accepted)).proposals,
    ];

    expect(proposals.map((proposal) => proposal.approval_state)).toEqual(["pending", "pending", "pending"]);
    expect(proposals.map((proposal) => proposal.proposed_item.stable_key)).toEqual([
      "user.intervention.confirmation_preference",
      "user.intervention.proactivity",
      "user.intervention.proactivity",
    ]);
    expect(proposals.every((proposal) => proposal.source === "proactive_feedback")).toBe(true);
  });

  it("avoids sensitive details when creating sensitive-overreach proposals", async () => {
    const baseDir = makeTempDir();
    const event = await new ProactiveInterventionStore(baseDir).appendFeedback({
      interventionId: "intervention-sensitive",
      outcome: "overreach",
      overreachIndicators: ["sensitive"],
      reason: "Health details were used in a proactive suggestion.",
      recordedAt: "2026-05-03T00:02:00.000Z",
    });

    const result = await createRelationshipProfileProposalsFromProactiveFeedback(baseDir, event);
    const serialized = JSON.stringify(result.proposals[0]);

    expect(result.proposals[0]?.proposed_item.value).toBe(
      "Avoid using sensitive context for proactive interventions unless the user explicitly confirms it."
    );
    expect(serialized).not.toContain("Health details");
  });

  it("keeps rejected feedback proposals out of resident behavior", async () => {
    const baseDir = makeTempDir();
    const event = await new ProactiveInterventionStore(baseDir).appendFeedback({
      interventionId: "intervention-rejected",
      outcome: "overreach",
      overreachIndicators: ["too_frequent"],
      reason: "Too many proactive suggestions.",
      recordedAt: "2026-05-03T00:03:00.000Z",
    });
    const result = await createRelationshipProfileProposalsFromProactiveFeedback(baseDir, event);
    await rejectRelationshipProfileChangeProposal(baseDir, result.proposals[0]!.id, {
      reason: "Do not change resident behavior from this feedback.",
      now: "2026-05-03T00:04:00.000Z",
    });

    const profile = await loadRelationshipProfile(baseDir);
    expect(profile.items).toHaveLength(0);

    const sendMessage = vi.fn().mockResolvedValue({ content: JSON.stringify({ action: "sleep", details: {} }) });
    const llmClient = {
      sendMessage,
      parseJSON: vi.fn().mockImplementation((content: string, schema: { parse(value: unknown): unknown }) =>
        schema.parse(JSON.parse(content))
      ),
    };

    await runProactiveMaintenance({
      config: DaemonConfigSchema.parse({
        proactive_mode: true,
        proactive_interval_ms: 1,
        runtime_root: baseDir,
      }),
      llmClient: llmClient as never,
      state: DaemonStateSchema.parse({
        pid: 123,
        started_at: "2026-05-03T00:00:00.000Z",
        last_loop_at: null,
        loop_count: 0,
        active_goals: [],
        status: "idle",
      }),
      lastProactiveTickAt: 0,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    const prompt = sendMessage.mock.calls[0]?.[0]?.[0]?.content ?? "";
    expect(prompt).not.toContain("Reduce the frequency of non-urgent proactive interventions");
  });
});
