import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyRelationshipProfileChangeProposal,
  approveRelationshipProfileChangeProposal,
  createRelationshipProfileChangeProposal,
  loadRelationshipProfileProposalStore,
  RelationshipProfileChangeProposalSchema,
  rejectRelationshipProfileChangeProposal,
} from "../profile-change-proposal.js";
import {
  formatRelationshipProfilePromptBlock,
  loadRelationshipProfile,
  saveRelationshipProfile,
  selectActiveRelationshipProfileItems,
  upsertRelationshipProfileItemInStore,
} from "../relationship-profile.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-profile-proposal-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("relationship profile proposal store", () => {
  it("approves and applies proposals through the relationship profile lifecycle path", async () => {
    const baseDir = makeTempDir();
    const created = await createRelationshipProfileChangeProposal(baseDir, {
      operation: "upsert_item",
      stableKey: "user.preference.status",
      kind: "preference",
      value: "Prefer concise status reports.",
      source: "cli_proposal",
      confidence: 0.88,
      sensitivity: "private",
      consentScopes: ["user_facing_review"],
      allowedScopes: ["local_planning", "memory_retrieval", "user_facing_review"],
      evidenceRefs: ["proposal:test"],
      rationale: "The user explicitly corrected the status-report preference.",
      now: "2026-05-03T00:00:00.000Z",
    });

    const approved = await approveRelationshipProfileChangeProposal(baseDir, created.proposal.id, {
      reason: "Operator approved.",
      now: "2026-05-03T00:01:00.000Z",
    });
    const applied = await applyRelationshipProfileChangeProposal(baseDir, approved.proposal.id, {
      now: "2026-05-03T00:02:00.000Z",
    });

    expect(created.proposal.approval_state).toBe("pending");
    expect(approved.proposal.approval_state).toBe("approved");
    expect(applied.proposal.approval_state).toBe("applied");
    expect(applied.item.stable_key).toBe("user.preference.status");

    const profile = await loadRelationshipProfile(baseDir);
    expect(selectActiveRelationshipProfileItems(profile, "memory_retrieval").map((item) => item.value)).toEqual([
      "Prefer concise status reports.",
    ]);
    expect(profile.audit_events.at(-1)).toMatchObject({
      action: "seeded",
      proposal_id: created.proposal.id,
    });

    const proposals = await loadRelationshipProfileProposalStore(baseDir);
    expect(proposals.audit_events.map((event) => event.action)).toEqual(["created", "approved", "applied"]);
    expect(proposals.proposals[0]?.applied_profile_item_id).toBe(applied.item.id);
  });

  it("rejects proposals without affecting prompt or retrieval contexts", async () => {
    const baseDir = makeTempDir();
    const created = await createRelationshipProfileChangeProposal(baseDir, {
      operation: "upsert_item",
      stableKey: "user.boundary.notifications",
      kind: "boundary",
      value: "Allow every proactive notification.",
      source: "cli_proposal",
      confidence: 0.5,
      sensitivity: "private",
      consentScopes: ["user_facing_review"],
      allowedScopes: ["local_planning", "memory_retrieval", "resident_behavior", "user_facing_review"],
      evidenceRefs: ["proposal:rejected"],
      rationale: "A rejected proposal should remain review-only.",
      now: "2026-05-03T00:00:00.000Z",
    });

    const rejected = await rejectRelationshipProfileChangeProposal(baseDir, created.proposal.id, {
      reason: "Operator rejected.",
      now: "2026-05-03T00:01:00.000Z",
    });

    expect(rejected.proposal.approval_state).toBe("rejected");
    const profile = await loadRelationshipProfile(baseDir);
    expect(selectActiveRelationshipProfileItems(profile, "memory_retrieval")).toEqual([]);
    expect(formatRelationshipProfilePromptBlock(profile, "resident_behavior")).not.toContain("Allow every proactive notification.");
    await expect(applyRelationshipProfileChangeProposal(baseDir, created.proposal.id)).rejects.toThrow("only approved proposals");
  });

  it("rejects invalid upsert proposals at the schema boundary", () => {
    const parsed = RelationshipProfileChangeProposalSchema.safeParse({
      id: "profile-proposal-invalid",
      operation: "upsert_item",
      proposed_item: {
        stable_key: "user.preference.status",
        allowed_scopes: ["local_planning"],
        sensitivity: "private",
      },
      source: "cli_proposal",
      confidence: 0.8,
      sensitivity: "private",
      consent_scopes: ["user_facing_review"],
      evidence_refs: [],
      rationale: "Invalid because the proposed item is incomplete.",
      approval_state: "pending",
      created_at: "2026-05-03T00:00:00.000Z",
      updated_at: "2026-05-03T00:00:00.000Z",
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "proposed_item.kind",
      "proposed_item.value",
    ]);
  });

  it("recovers an approved proposal already linked from profile audit without replaying the mutation", async () => {
    const baseDir = makeTempDir();
    const created = await createRelationshipProfileChangeProposal(baseDir, {
      operation: "upsert_item",
      stableKey: "user.preference.status",
      kind: "preference",
      value: "Prefer concise status reports.",
      source: "cli_proposal",
      confidence: 0.88,
      sensitivity: "private",
      consentScopes: ["user_facing_review"],
      allowedScopes: ["local_planning", "memory_retrieval", "user_facing_review"],
      evidenceRefs: ["proposal:recover"],
      rationale: "The user explicitly corrected the status-report preference.",
      now: "2026-05-03T00:00:00.000Z",
    });
    await approveRelationshipProfileChangeProposal(baseDir, created.proposal.id, {
      now: "2026-05-03T00:01:00.000Z",
    });

    const profileStore = await loadRelationshipProfile(baseDir);
    const profileResult = upsertRelationshipProfileItemInStore(profileStore, {
      stableKey: "user.preference.status",
      kind: "preference",
      value: "Prefer concise status reports.",
      source: "user_correction",
      confidence: 0.88,
      sensitivity: "private",
      allowedScopes: ["local_planning", "memory_retrieval", "user_facing_review"],
      evidenceRef: "proposal:recover",
      note: "The user explicitly corrected the status-report preference.",
      proposalId: created.proposal.id,
      now: "2026-05-03T00:02:00.000Z",
    });
    await saveRelationshipProfile(baseDir, profileResult.store);

    const recovered = await applyRelationshipProfileChangeProposal(baseDir, created.proposal.id, {
      now: "2026-05-03T00:03:00.000Z",
    });
    const after = await loadRelationshipProfile(baseDir);

    expect(recovered.proposal.approval_state).toBe("applied");
    expect(recovered.item.id).toBe(profileResult.item.id);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]?.version).toBe(1);
  });

  it("treats repeated apply of an already-applied proposal as idempotent", async () => {
    const baseDir = makeTempDir();
    const created = await createRelationshipProfileChangeProposal(baseDir, {
      operation: "upsert_item",
      stableKey: "user.preference.status",
      kind: "preference",
      value: "Prefer concise status reports.",
      source: "cli_proposal",
      confidence: 0.88,
      sensitivity: "private",
      consentScopes: ["user_facing_review"],
      allowedScopes: ["local_planning", "memory_retrieval", "user_facing_review"],
      evidenceRefs: ["proposal:idempotent"],
      rationale: "The user explicitly corrected the status-report preference.",
      now: "2026-05-03T00:00:00.000Z",
    });
    await approveRelationshipProfileChangeProposal(baseDir, created.proposal.id, {
      now: "2026-05-03T00:01:00.000Z",
    });
    const firstApply = await applyRelationshipProfileChangeProposal(baseDir, created.proposal.id, {
      now: "2026-05-03T00:02:00.000Z",
    });
    const secondApply = await applyRelationshipProfileChangeProposal(baseDir, created.proposal.id, {
      now: "2026-05-03T00:03:00.000Z",
    });
    const profile = await loadRelationshipProfile(baseDir);

    expect(secondApply.proposal.approval_state).toBe("applied");
    expect(secondApply.item.id).toBe(firstApply.item.id);
    expect(profile.items).toHaveLength(1);
    expect(profile.items[0]?.version).toBe(1);
    expect(profile.audit_events.filter((event) => event.proposal_id === created.proposal.id)).toHaveLength(1);
  });

  it("recovers replacement upserts to the created item instead of the superseded item", async () => {
    const baseDir = makeTempDir();
    let profileStore = await loadRelationshipProfile(baseDir);
    const original = upsertRelationshipProfileItemInStore(profileStore, {
      stableKey: "user.preference.status",
      kind: "preference",
      value: "Prefer verbose status reports.",
      source: "cli_update",
      allowedScopes: ["local_planning", "memory_retrieval", "user_facing_review"],
      now: "2026-05-03T00:00:00.000Z",
    });
    await saveRelationshipProfile(baseDir, original.store);

    const created = await createRelationshipProfileChangeProposal(baseDir, {
      operation: "upsert_item",
      stableKey: "user.preference.status",
      kind: "preference",
      value: "Prefer concise status reports.",
      source: "cli_proposal",
      confidence: 0.88,
      sensitivity: "private",
      consentScopes: ["user_facing_review"],
      allowedScopes: ["local_planning", "memory_retrieval", "user_facing_review"],
      evidenceRefs: ["proposal:replacement-recover"],
      rationale: "The user corrected the prior preference.",
      now: "2026-05-03T00:01:00.000Z",
    });
    await approveRelationshipProfileChangeProposal(baseDir, created.proposal.id, {
      now: "2026-05-03T00:02:00.000Z",
    });

    profileStore = await loadRelationshipProfile(baseDir);
    const replacement = upsertRelationshipProfileItemInStore(profileStore, {
      stableKey: "user.preference.status",
      kind: "preference",
      value: "Prefer concise status reports.",
      source: "user_correction",
      confidence: 0.88,
      sensitivity: "private",
      allowedScopes: ["local_planning", "memory_retrieval", "user_facing_review"],
      evidenceRef: "proposal:replacement-recover",
      note: "The user corrected the prior preference.",
      proposalId: created.proposal.id,
      now: "2026-05-03T00:03:00.000Z",
    });
    await saveRelationshipProfile(baseDir, replacement.store);

    const recovered = await applyRelationshipProfileChangeProposal(baseDir, created.proposal.id, {
      now: "2026-05-03T00:04:00.000Z",
    });
    const after = await loadRelationshipProfile(baseDir);

    expect(recovered.item.id).toBe(replacement.item.id);
    expect(recovered.item.status).toBe("active");
    expect(after.items.map((item) => [item.version, item.status])).toEqual([
      [1, "superseded"],
      [2, "active"],
    ]);
  });
});
