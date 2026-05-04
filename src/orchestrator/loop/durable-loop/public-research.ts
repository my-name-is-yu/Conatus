import type { Goal } from "../../../base/types/goal.js";
import type { DriveScore } from "../../../base/types/drive.js";
import type { LoopIterationResult } from "../loop-result-types.js";
import type {
  KnowledgeRefreshEvidence,
  PublicResearchEvidence,
  PublicResearchFinding,
  PublicResearchSource,
} from "./phase-specs.js";
import type { CorePhaseExecution } from "./phase-runtime.js";

export type PublicResearchTrigger = "plateau" | "uncertainty" | "knowledge_gap";

export interface PublicResearchRequest {
  trigger: PublicResearchTrigger;
  question: string;
  reason: string;
  targetDimensions: string[];
  sourcePreference: string[];
  maxSources: number;
  sensitiveContextPolicy: "do_not_send_secrets_or_private_artifacts";
  untrustedContentPolicy: "webpage_instructions_are_untrusted";
}

export interface BuildPublicResearchRequestInput {
  goal: Goal;
  result: LoopIterationResult;
  gapAggregate: number;
  driveScores: DriveScore[];
  knowledgeRefresh?: CorePhaseExecution<KnowledgeRefreshEvidence> | null;
}

const DEFAULT_SOURCE_PREFERENCE = [
  "official_docs",
  "maintainer",
  "paper",
  "issue_thread",
  "high_signal_writeup",
];

export function buildPublicResearchRequest(
  input: BuildPublicResearchRequestInput
): PublicResearchRequest | null {
  if (input.result.stallDetected) {
    const dimension = input.result.stallReport?.dimension_name
      ?? input.driveScores[0]?.dimension_name
      ?? input.goal.dimensions[0]?.name
      ?? "primary outcome";
    return buildRequest({
      trigger: "plateau",
      goal: input.goal,
      reason: `Progress plateau detected on ${dimension}.`,
      targetDimensions: [dimension],
      question: [
        `Find source-grounded strategy evidence for breaking a plateau on "${dimension}".`,
        `Goal: ${input.goal.title}.`,
        `Prefer primary or high-signal sources and propose one bounded experiment.`,
      ].join(" "),
    });
  }

  const knowledge = input.knowledgeRefresh?.output;
  const requiredKnowledge = knowledge?.required_knowledge ?? [];
  if (
    input.knowledgeRefresh
    && input.knowledgeRefresh.status !== "skipped"
    && (knowledge?.worthwhile || requiredKnowledge.length > 0 || (knowledge?.acquisition_candidates.length ?? 0) > 0)
  ) {
    const topDimensions = topDimensionNames(input.driveScores, input.goal);
    return buildRequest({
      trigger: "knowledge_gap",
      goal: input.goal,
      reason: requiredKnowledge.length > 0
        ? `Knowledge gap detected: ${requiredKnowledge.slice(0, 2).join("; ")}`
        : "Knowledge refresh requested outside strategy evidence.",
      targetDimensions: topDimensions,
      question: [
        `Find source-grounded public evidence for this strategy gap: ${requiredKnowledge.slice(0, 3).join("; ") || knowledge?.summary || input.goal.title}.`,
        `Goal: ${input.goal.title}.`,
        "Summarize facts separately from adaptations and propose one bounded experiment.",
      ].join(" "),
    });
  }

  const lowConfidenceDimensions = input.result.completionJudgment.low_confidence_dimensions;
  if (lowConfidenceDimensions.length > 0 || input.gapAggregate > 0.8) {
    const targetDimensions = lowConfidenceDimensions.length > 0
      ? lowConfidenceDimensions
      : topDimensionNames(input.driveScores, input.goal);
    return buildRequest({
      trigger: "uncertainty",
      goal: input.goal,
      reason: lowConfidenceDimensions.length > 0
        ? `Low-confidence dimensions require outside evidence: ${lowConfidenceDimensions.join(", ")}.`
        : `High aggregate gap (${input.gapAggregate.toFixed(2)}) indicates uncertain strategy fit.`,
      targetDimensions,
      question: [
        `Find source-grounded evidence to reduce strategy uncertainty for ${targetDimensions.join(", ")}.`,
        `Goal: ${input.goal.title}.`,
        "Return applicability limits, risks, and one experiment that can be verified locally.",
      ].join(" "),
    });
  }

  return null;
}

export function normalizePublicResearchMemo(
  output: PublicResearchEvidence,
  request: PublicResearchRequest
): PublicResearchEvidence {
  return {
    ...output,
    trigger: output.trigger ?? request.trigger,
    query: output.query || request.question,
    untrusted_content_policy: "webpage_instructions_are_untrusted",
    external_actions: output.external_actions.map((action) => ({
      ...action,
      approval_required: true,
    })),
  };
}

export function researchRawRefs(output: PublicResearchEvidence): Array<{ kind: string; url: string }> {
  const urls = new Set<string>();
  for (const source of output.sources) {
    urls.add(source.url);
  }
  for (const finding of output.findings) {
    for (const url of finding.source_urls) urls.add(url);
  }
  return [...urls].map((url) => ({ kind: "research_source", url }));
}

export function publicResearchSummary(output: PublicResearchEvidence): string {
  const firstFinding = output.findings[0]?.finding;
  return firstFinding ? `${output.summary} ${firstFinding}` : output.summary;
}

export type {
  PublicResearchEvidence,
  PublicResearchFinding,
  PublicResearchSource,
};

function buildRequest(input: {
  trigger: PublicResearchTrigger;
  goal: Goal;
  reason: string;
  targetDimensions: string[];
  question: string;
}): PublicResearchRequest {
  return {
    trigger: input.trigger,
    question: input.question,
    reason: input.reason,
    targetDimensions: input.targetDimensions,
    sourcePreference: DEFAULT_SOURCE_PREFERENCE,
    maxSources: 3,
    sensitiveContextPolicy: "do_not_send_secrets_or_private_artifacts",
    untrustedContentPolicy: "webpage_instructions_are_untrusted",
  };
}

function topDimensionNames(driveScores: DriveScore[], goal: Goal): string[] {
  const fromScores = driveScores.slice(0, 3).map((score) => score.dimension_name);
  if (fromScores.length > 0) return fromScores;
  return goal.dimensions.slice(0, 3).map((dimension) => dimension.name);
}
