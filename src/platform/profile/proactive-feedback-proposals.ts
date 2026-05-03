import type { ProactiveInterventionFeedbackEvent } from "../../runtime/store/proactive-intervention-store.js";
import {
  createRelationshipProfileChangeProposal,
  type RelationshipProfileChangeProposal,
  type RelationshipProfileProposalInput,
} from "./profile-change-proposal.js";
import type { RelationshipProfileSensitivity } from "./relationship-profile.js";

type FeedbackProposalDraft = Omit<RelationshipProfileProposalInput, "source" | "now">;

function evidenceRefsForFeedback(event: ProactiveInterventionFeedbackEvent): string[] {
  return [
    `proactive-intervention:event:${event.event_id}`,
    `proactive-intervention:intervention:${event.intervention_id}`,
  ];
}

function proposalSensitivity(event: ProactiveInterventionFeedbackEvent): RelationshipProfileSensitivity {
  return event.overreach_indicators.includes("sensitive") ? "private" : "private";
}

function policyValueForRecommendation(event: ProactiveInterventionFeedbackEvent): string | null {
  const recommendation = event.policy_adjustment_recommendation;
  if (!recommendation) return null;
  if (recommendation.suggested_action === "avoid_sensitive_context") {
    return "Avoid using sensitive context for proactive interventions unless the user explicitly confirms it.";
  }
  if (recommendation.suggested_action === "reduce_frequency") {
    return "Reduce the frequency of non-urgent proactive interventions and prefer fewer, higher-confidence suggestions.";
  }
  if (recommendation.suggested_action === "require_confirmation") {
    return "Ask for confirmation before acting on non-urgent proactive suggestions.";
  }
  if (recommendation.suggested_action === "narrow_scope") {
    return "Narrow proactive interventions to the current task context unless the user explicitly broadens scope.";
  }
  return null;
}

export function buildRelationshipProfileProposalDraftsFromProactiveFeedback(
  event: ProactiveInterventionFeedbackEvent
): FeedbackProposalDraft[] {
  const evidenceRefs = evidenceRefsForFeedback(event);
  const sensitivity = proposalSensitivity(event);
  const recommendation = event.policy_adjustment_recommendation;
  const recommendedValue = policyValueForRecommendation(event);

  if (recommendation && recommendedValue) {
    return [{
      operation: "upsert_item",
      stableKey: recommendation.relationship_profile_key,
      kind: "intervention_policy",
      value: recommendedValue,
      confidence: event.outcome === "overreach" ? 0.86 : 0.78,
      sensitivity,
      consentScopes: ["user_facing_review"],
      allowedScopes: ["resident_behavior", "user_facing_review"],
      evidenceRefs,
      rationale: event.overreach_indicators.includes("sensitive")
        ? `Proactive feedback ${event.event_id} marked an intervention as sensitive overreach; route the policy update through approval before applying.`
        : `Proactive feedback ${event.event_id} produced a typed ${recommendation.suggested_action} recommendation for ${recommendation.relationship_profile_key}.`,
    }];
  }

  if (event.outcome === "ignored") {
    return [{
      operation: "upsert_item",
      stableKey: "user.intervention.confirmation_preference",
      kind: "intervention_policy",
      value: "Ask for confirmation before repeating proactive interventions that the user ignores.",
      confidence: 0.58,
      sensitivity,
      consentScopes: ["user_facing_review"],
      allowedScopes: ["resident_behavior", "user_facing_review"],
      evidenceRefs,
      rationale: `Proactive feedback ${event.event_id} was recorded as ignored; require approval before changing intervention behavior.`,
    }];
  }

  if (event.outcome === "dismissed") {
    return [{
      operation: "upsert_item",
      stableKey: "user.intervention.proactivity",
      kind: "intervention_policy",
      value: "Reduce non-urgent proactive interventions after dismissed suggestions.",
      confidence: 0.62,
      sensitivity,
      consentScopes: ["user_facing_review"],
      allowedScopes: ["resident_behavior", "user_facing_review"],
      evidenceRefs,
      rationale: `Proactive feedback ${event.event_id} was dismissed; route any policy change through approval before applying.`,
    }];
  }

  if (event.outcome === "accepted" && event.follow_through_success === true) {
    return [{
      operation: "upsert_item",
      stableKey: "user.intervention.proactivity",
      kind: "intervention_policy",
      value: "Continue similar proactive interventions when confidence is high and the context is non-sensitive.",
      confidence: 0.55,
      sensitivity,
      consentScopes: ["user_facing_review"],
      allowedScopes: ["resident_behavior", "user_facing_review"],
      evidenceRefs,
      rationale: `Proactive feedback ${event.event_id} was accepted with successful follow-through; keep the change governed as a proposal.`,
    }];
  }

  return [];
}

export async function createRelationshipProfileProposalsFromProactiveFeedback(
  baseDir: string,
  event: ProactiveInterventionFeedbackEvent,
  params: { now?: string } = {}
): Promise<{ proposals: RelationshipProfileChangeProposal[] }> {
  const proposals: RelationshipProfileChangeProposal[] = [];
  for (const draft of buildRelationshipProfileProposalDraftsFromProactiveFeedback(event)) {
    const result = await createRelationshipProfileChangeProposal(baseDir, {
      ...draft,
      source: "proactive_feedback",
      now: params.now ?? event.recorded_at,
    });
    proposals.push(result.proposal);
  }
  return { proposals };
}
