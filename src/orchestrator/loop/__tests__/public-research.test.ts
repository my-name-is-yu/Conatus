import { describe, expect, it } from "vitest";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";
import { makeEmptyIterationResult } from "../loop-result-types.js";
import {
  buildPublicResearchRequest,
} from "../durable-loop/public-research.js";
import {
  PublicResearchEvidenceSchema,
  PublicResearchExternalActionSchema,
} from "../durable-loop/phase-specs.js";
import { StaticCorePhasePolicyRegistry } from "../durable-loop/phase-policy.js";

describe("public research planning", () => {
  it("requests bounded research when a plateau/stall is detected", () => {
    const result = makeEmptyIterationResult("goal-1", 0, {
      stallDetected: true,
      stallReport: {
        stall_type: "dimension_stall",
        goal_id: "goal-1",
        dimension_name: "accuracy",
        task_id: null,
        detected_at: "2026-04-30T00:00:00.000Z",
        escalation_level: 1,
        suggested_cause: "approach_failure",
        decay_factor: 0.5,
      },
    });

    const request = buildPublicResearchRequest({
      goal: makeGoal({ title: "Improve benchmark score" }),
      result,
      gapAggregate: 0.6,
      driveScores: [{
        dimension_name: "accuracy",
        dissatisfaction: 0.6,
        deadline: 0,
        opportunity: 0,
        final_score: 0.6,
        dominant_drive: "dissatisfaction",
      }],
    });

    expect(request).toMatchObject({
      trigger: "plateau",
      targetDimensions: ["accuracy"],
      maxSources: 3,
      sensitiveContextPolicy: "do_not_send_secrets_or_private_artifacts",
      untrustedContentPolicy: "webpage_instructions_are_untrusted",
    });
    expect(request?.question).toContain("source-grounded");
  });

  it("requests research from a knowledge gap without requiring a stall", () => {
    const request = buildPublicResearchRequest({
      goal: makeGoal({ title: "Migrate API client" }),
      result: makeEmptyIterationResult("goal-1", 0),
      gapAggregate: 0.4,
      driveScores: [],
      knowledgeRefresh: {
        phase: "knowledge_refresh",
        status: "completed",
        output: {
          summary: "Need current API migration constraints.",
          required_knowledge: ["official migration constraints"],
          acquisition_candidates: ["public docs"],
          confidence: 0.8,
          worthwhile: true,
        },
      },
    });

    expect(request).toMatchObject({
      trigger: "knowledge_gap",
      targetDimensions: ["dim1"],
    });
    expect(request?.question).toContain("official migration constraints");
  });

  it("captures source summary shape and rejects non-gated external actions", () => {
    const parsed = PublicResearchEvidenceSchema.parse({
      summary: "Official docs suggest using a staged migration.",
      trigger: "knowledge_gap",
      query: "API migration constraints",
      sources: [{
        url: "https://example.com/docs/migration",
        title: "Migration guide",
        source_type: "official_docs",
        provenance: "paraphrased",
      }],
      findings: [{
        finding: "Staged migration reduces blast radius.",
        source_urls: ["https://example.com/docs/migration"],
        applicability: "Applies to client upgrades with compatibility windows.",
        risks_constraints: ["Version skew must be tested."],
        proposed_experiment: "Run the new client behind a feature flag in tests.",
        expected_metric_impact: "Lower rollback risk.",
        fact_vs_adaptation: {
          facts: ["The source recommends staged rollout."],
          adaptation: "Use the same pattern for this runtime client.",
        },
      }],
    });

    expect(parsed.untrusted_content_policy).toBe("webpage_instructions_are_untrusted");
    expect(parsed.findings[0]?.applicability).toContain("client upgrades");
    expect(PublicResearchExternalActionSchema.safeParse({
      label: "Submit artifact",
      reason: "Needs external benchmark",
      approval_required: false,
    }).success).toBe(false);
  });

  it("keeps the public research phase read-only and bounded", () => {
    const policy = new StaticCorePhasePolicyRegistry().get("public_research");

    expect(policy.enabled).toBe(true);
    expect(policy.allowedTools).toEqual(["research_web", "research_answer_with_sources"]);
    expect(policy.requiredTools).toEqual(["research_answer_with_sources"]);
    expect(policy.budget.maxToolCalls).toBeLessThanOrEqual(4);
    expect(policy.allowedTools).not.toEqual(expect.arrayContaining([
      "shell_command",
      "browser_run_workflow",
      "http_fetch",
      "kaggle_submission_prepare",
    ]));
  });
});
