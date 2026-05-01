import { randomUUID } from "node:crypto";
import type {
  RunSpec,
  RunSpecApprovalPolicy,
  RunSpecArtifactContract,
  RunSpecDeadline,
  RunSpecDerivationContext,
  RunSpecMetric,
  RunSpecMissingField,
  RunSpecProgressContract,
} from "./types.js";

const LONG_RUNNING_TERMS = [
  /\blong[-\s]?running\b/i,
  /\bbackground\b/i,
  /\brun\b.+\buntil\b/i,
  /\bkeep\b.+\brunning\b/i,
  /\bcontinue\b.+\buntil\b/i,
  /\bdaemon\b/i,
  /\bcoreloop\b/i,
  /長期/,
  /常駐/,
  /まで.*(実行|走|回|取り組|続け)/,
];

const KAGGLE_TERMS = [
  /\bkaggle\b/i,
  /\bcompetition\b/i,
  /\bleaderboard\b/i,
  /\bsubmission\b/i,
  /\bsubmit\b/i,
  /コンペ/,
  /提出/,
];

const EXPLANATORY_QUESTION_TERMS = [
  /\bwhy\b/i,
  /\bhow does\b/i,
  /\bwhat is\b/i,
  /\?/,
  /なぜ/,
  /どうして/,
  /とは/,
];

export interface RunSpecIntent {
  needsRunSpec: true;
  profile: "generic" | "kaggle";
  reason: string;
}

export function recognizeRunSpecIntent(text: string): RunSpecIntent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const profile = KAGGLE_TERMS.some((pattern) => pattern.test(trimmed)) ? "kaggle" : "generic";
  const longRunning = LONG_RUNNING_TERMS.some((pattern) => pattern.test(trimmed));
  const hasThreshold = /(top\s*\d+(?:\.\d+)?\s*%|score\s*[<>=>]*\s*\d|accuracy\s*[<>=>]*\s*\d|auc\s*[<>=>]*\s*\d|rmse\s*[<>=>]*\s*\d|loss\s*[<>=>]*\s*\d)/i.test(trimmed);
  const asksForExplanation = EXPLANATORY_QUESTION_TERMS.some((pattern) => pattern.test(trimmed));
  const hasOperatorVerb = /\b(run|keep|continue|start|execute|optimi[sz]e|improve|aim|reach)\b|実行|走|回|取り組|続け|目指/i.test(trimmed);

  if (asksForExplanation && !/\b(run|keep|continue|start|do|execute)\b/i.test(trimmed)) {
    return null;
  }

  if (profile === "kaggle" && hasOperatorVerb && (longRunning || hasThreshold || /\buntil\b/i.test(trimmed))) {
    return { needsRunSpec: true, profile, reason: "kaggle_long_running_request" };
  }
  if (longRunning && hasOperatorVerb && !asksForExplanation) {
    return { needsRunSpec: true, profile, reason: "long_running_request" };
  }
  return null;
}

export function deriveRunSpecFromText(text: string, context: RunSpecDerivationContext = {}): RunSpec | null {
  const intent = recognizeRunSpecIntent(text);
  if (!intent) return null;

  const now = context.now ?? new Date();
  const createdAt = now.toISOString();
  const missingFields: RunSpecMissingField[] = [];
  const workspace = deriveWorkspace(text, context.cwd);
  if (!workspace) {
    missingFields.push({
      field: "workspace",
      question: "Which local or remote workspace should PulSeed use for this run?",
      severity: "required",
    });
  }

  const deadline = deriveDeadline(text, now, context.timezone);
  if (!deadline) {
    missingFields.push({
      field: "deadline",
      question: "What deadline or review time should PulSeed plan around?",
      severity: "required",
    });
  }

  const metric = deriveMetric(text, intent.profile);
  if (metric && metric.direction === "unknown" && metric.target !== null) {
    missingFields.push({
      field: "metric.direction",
      question: `Should ${metric.name} be maximized or minimized?`,
      severity: "required",
    });
  }

  const progressContract = deriveProgressContract(text, metric, deadline);
  const approvalPolicy = deriveApprovalPolicy(text);
  const artifactContract = deriveArtifactContract(intent.profile);
  const objective = text.trim().replace(/\s+/g, " ");
  const confidence = missingFields.some((field) => field.severity === "required")
    ? "medium"
    : "high";

  return {
    schema_version: "run-spec-v1",
    id: `runspec-${randomUUID()}`,
    status: "draft",
    profile: intent.profile,
    source_text: text,
    objective,
    workspace,
    execution_target: deriveExecutionTarget(text),
    metric,
    progress_contract: progressContract,
    deadline,
    budget: {
      max_trials: deriveMaxTrials(text),
      max_wall_clock_minutes: deadline?.iso_at ? minutesUntil(now, new Date(deadline.iso_at)) : null,
      resident_policy: deadline ? "until_deadline" : "unknown",
    },
    approval_policy: approvalPolicy,
    artifact_contract: artifactContract,
    risk_flags: deriveRiskFlags(approvalPolicy),
    missing_fields: missingFields,
    confidence,
    links: {
      goal_id: null,
      runtime_session_id: null,
      conversation_id: context.conversationId ?? null,
    },
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function deriveWorkspace(text: string, cwd: string | undefined) {
  const explicitPath = text.match(/(?:workspace|cwd|directory|dir|repo|path)\s+((?:~|\/)[^\s,]+)/i)?.[1]
    ?? text.match(/(?:ワークスペース|ディレクトリ|repo|リポジトリ)[^\s/]*(\/[^\s,]+)/i)?.[1];
  if (explicitPath) {
    return { path: explicitPath, source: "user" as const, confidence: "high" as const };
  }
  const normalizedCwd = cwd?.trim();
  if (normalizedCwd) {
    return { path: normalizedCwd, source: "context" as const, confidence: "medium" as const };
  }
  return null;
}

function deriveExecutionTarget(text: string) {
  const remoteHost = text.match(/\b(?:on|host|ssh)\s+([a-zA-Z0-9_.-]+)\b/i)?.[1] ?? null;
  if (remoteHost) {
    return { kind: "remote" as const, remote_host: remoteHost, confidence: "medium" as const };
  }
  if (/\bdaemon\b|coreloop/i.test(text)) {
    return { kind: "daemon" as const, remote_host: null, confidence: "medium" as const };
  }
  return { kind: "local" as const, remote_host: null, confidence: "low" as const };
}

function deriveMetric(text: string, profile: "generic" | "kaggle"): RunSpecMetric | null {
  const topMatch = text.match(/\btop\s*(\d+(?:\.\d+)?)\s*%/i);
  if (topMatch) {
    return {
      name: "leaderboard_rank_percentile",
      direction: "minimize",
      target: null,
      target_rank_percent: Number(topMatch[1]),
      datasource: profile === "kaggle" ? "kaggle_leaderboard" : null,
      confidence: "high",
    };
  }

  const metricMatch = text.match(/\b(accuracy|auc|rmse|mae|loss|score|balanced_accuracy)\b[^\d<>=>-]*[<>=>]*\s*(-?\d+(?:\.\d+)?)/i);
  if (!metricMatch) return null;
  const name = metricMatch[1].toLowerCase();
  return {
    name,
    direction: inferMetricDirection(text, name),
    target: Number(metricMatch[2]),
    target_rank_percent: null,
    datasource: profile === "kaggle" ? "kaggle_metrics" : null,
    confidence: "medium",
  };
}

function inferMetricDirection(text: string, metricName: string): "maximize" | "minimize" | "unknown" {
  if (/\b(maximi[sz]e|increase|higher|best|improve|上げ|高く|最大)\b/i.test(text)) return "maximize";
  if (/\b(minimi[sz]e|decrease|lower|reduce|下げ|低く|最小)\b/i.test(text)) return "minimize";
  if (/^(accuracy|auc|balanced_accuracy)$/.test(metricName)) return "maximize";
  if (/^(rmse|mae|loss)$/.test(metricName)) return "minimize";
  return "unknown";
}

function deriveProgressContract(
  text: string,
  metric: RunSpecMetric | null,
  deadline: RunSpecDeadline | null,
): RunSpecProgressContract {
  if (metric?.target_rank_percent !== null && metric?.target_rank_percent !== undefined) {
    return {
      kind: "rank_percentile",
      dimension: metric.name,
      threshold: metric.target_rank_percent,
      semantics: "Reach a leaderboard rank percentile at or below the threshold.",
      confidence: "high",
    };
  }
  if (metric?.target !== null && metric?.target !== undefined) {
    return {
      kind: "metric_target",
      dimension: metric.name,
      threshold: metric.target,
      semantics: "Reach the requested metric target; metric direction is tracked separately.",
      confidence: metric.direction === "unknown" ? "medium" : "high",
    };
  }
  if (deadline && /\buntil\b|まで|期限|deadline/i.test(text)) {
    return {
      kind: "deadline_only",
      dimension: "time",
      threshold: null,
      semantics: "Keep useful work going until the requested deadline or review time.",
      confidence: "medium",
    };
  }
  return {
    kind: "open_ended",
    dimension: null,
    threshold: null,
    semantics: "Long-running work requested without an explicit measurable threshold.",
    confidence: "low",
  };
}

function deriveDeadline(text: string, now: Date, timezone: string | undefined): RunSpecDeadline | null {
  const lower = text.toLowerCase();
  if (lower.includes("tomorrow morning") || /明日.*(朝|午前)/.test(text)) {
    const at = new Date(now);
    at.setDate(at.getDate() + 1);
    at.setHours(9, 0, 0, 0);
    return {
      raw: lower.includes("tomorrow morning") ? "tomorrow morning" : "明日朝",
      iso_at: at.toISOString(),
      timezone: timezone ?? null,
      finalization_buffer_minutes: 60,
      confidence: "medium",
    };
  }
  const hoursMatch = text.match(/\b(?:for|within)\s+(\d+)\s*(hours?|hrs?)\b/i);
  if (hoursMatch) {
    const at = new Date(now.getTime() + Number(hoursMatch[1]) * 60 * 60 * 1000);
    return {
      raw: hoursMatch[0],
      iso_at: at.toISOString(),
      timezone: timezone ?? null,
      finalization_buffer_minutes: 30,
      confidence: "medium",
    };
  }
  return null;
}

function deriveMaxTrials(text: string): number | null {
  const match = text.match(/\b(?:max\s*)?(\d+)\s+(?:trials|runs|experiments)\b/i);
  return match ? Number(match[1]) : null;
}

function deriveApprovalPolicy(text: string): RunSpecApprovalPolicy {
  const approvalGated = /approval[-\s]?gated|approval required|ask before|確認して|承認/i.test(text);
  const submitMentioned = /\b(submit|submission|publish|external)\b|提出|公開/i.test(text);
  return {
    submit: approvalGated || submitMentioned ? "approval_required" : "unspecified",
    publish: approvalGated && /\bpublish\b|公開/i.test(text) ? "approval_required" : "unspecified",
    secret: "approval_required",
    external_action: approvalGated || submitMentioned ? "approval_required" : "unspecified",
    irreversible_action: "approval_required",
  };
}

function deriveArtifactContract(profile: "generic" | "kaggle"): RunSpecArtifactContract {
  if (profile === "kaggle") {
    return {
      expected_artifacts: ["submission files", "leaderboard metrics", "experiment notes", "model artifacts"],
      discovery_globs: ["**/submission*.csv", "**/leaderboard*.json", "**/metrics*.json", "reports/**/*.md"],
      primary_outputs: ["submission.csv", "metrics summary", "run report"],
    };
  }
  return {
    expected_artifacts: ["progress report", "metrics", "logs"],
    discovery_globs: ["reports/**/*.md", "**/metrics*.json", "**/*.log"],
    primary_outputs: ["progress summary", "final report"],
  };
}

function deriveRiskFlags(policy: RunSpecApprovalPolicy): string[] {
  const flags = ["secret_use_requires_approval", "irreversible_actions_require_approval"];
  if (policy.submit === "approval_required") flags.push("external_submit_requires_approval");
  if (policy.publish === "approval_required") flags.push("external_publish_requires_approval");
  return flags;
}

function minutesUntil(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
}
