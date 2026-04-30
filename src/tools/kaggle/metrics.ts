import { z } from "zod";

export const KaggleMetricDirectionSchema = z.enum(["maximize", "minimize"]);
export type KaggleMetricDirection = z.infer<typeof KaggleMetricDirectionSchema>;

export const KaggleMetricsSchema = z.object({
  experiment_id: z.string().min(1),
  competition: z.string().min(1),
  metric_name: z.string().min(1),
  direction: KaggleMetricDirectionSchema,
  cv_score: z.number().finite(),
  cv_std: z.number().finite().nullable(),
  holdout_score: z.number().finite().nullable(),
  train_rows: z.number().int().nonnegative(),
  valid_rows: z.number().int().nonnegative(),
  seed: z.number().int(),
  created_at: z.string().datetime(),
  status: z.enum(["running", "completed", "failed"]),
  artifacts: z.object({
    model: z.string().min(1).optional(),
    submission: z.string().min(1).optional(),
    log: z.string().min(1),
  }).strict(),
}).strict();

export type KaggleMetrics = z.infer<typeof KaggleMetricsSchema>;

export interface KaggleMetricsCompatibilityFallback {
  experiment_id?: string;
  competition?: string;
  created_at?: string;
  log_path?: string;
  submission_path?: string;
  model_path?: string;
}

export type KaggleMetricParseResult = {
  ok: true;
  metrics: KaggleMetrics;
  source_schema: "strict" | "loose";
  warnings: string[];
} | {
  ok: false;
  reason: "missing" | "malformed";
  message: string;
  issues?: string[];
};

export interface MetricThresholdHint {
  wait_condition_type: "metric_threshold";
  metric: string;
  operator: "gte" | "lte";
  value_required: true;
  metric_source: "wait_metadata.metrics";
  hint: string;
}

export function metricThresholdHintForDirection(
  metricName: string,
  direction: KaggleMetricDirection,
): MetricThresholdHint {
  const operator = direction === "maximize" ? "gte" : "lte";
  return {
    wait_condition_type: "metric_threshold",
    metric: metricName,
    operator,
    value_required: true,
    metric_source: "wait_metadata.metrics",
    hint: `${direction} ${metricName}: use metric_threshold operator ${operator} with a caller-supplied numeric threshold.`,
  };
}

export function parseKaggleMetrics(value: unknown): KaggleMetricParseResult {
  const parsed = KaggleMetricsSchema.safeParse(value);
  if (parsed.success) {
    return { ok: true, metrics: parsed.data, source_schema: "strict", warnings: [] };
  }
  return {
    ok: false,
    reason: "malformed",
    message: "metrics.json does not match the strict Kaggle metrics schema",
    issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
  };
}

export function parseKaggleMetricsCompatible(
  value: unknown,
  fallback: KaggleMetricsCompatibilityFallback = {},
): KaggleMetricParseResult {
  const strict = KaggleMetricsSchema.safeParse(value);
  if (strict.success) {
    return { ok: true, metrics: strict.data, source_schema: "strict", warnings: [] };
  }
  const loose = normalizeLooseKaggleMetrics(value, fallback);
  if (loose) {
    const parsed = KaggleMetricsSchema.safeParse(loose.metrics);
    if (parsed.success) {
      return {
        ok: true,
        metrics: parsed.data,
        source_schema: "loose",
        warnings: loose.warnings,
      };
    }
  }
  return {
    ok: false,
    reason: "malformed",
    message: "metrics.json does not match the strict Kaggle metrics schema or supported loose Kaggle metric schema",
    issues: strict.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
  };
}

export function normalizedMetricScore(metrics: KaggleMetrics): number {
  return metrics.direction === "maximize" ? metrics.cv_score : -metrics.cv_score;
}

export function compareMetricScores(a: KaggleMetrics, b: KaggleMetrics): number {
  return normalizedMetricScore(b) - normalizedMetricScore(a);
}

function normalizeLooseKaggleMetrics(
  value: unknown,
  fallback: KaggleMetricsCompatibilityFallback,
): { metrics: KaggleMetrics; warnings: string[] } | null {
  if (!isRecord(value)) return null;
  const allMetrics = isRecord(value["all_metrics"]) ? value["all_metrics"] : null;
  const metricName = stringField(value, "metric_name")
    ?? firstNumericMetricName(allMetrics)
    ?? (numberField(value, "balanced_accuracy") !== null ? "balanced_accuracy" : null)
    ?? (numberField(value, "accuracy") !== null ? "accuracy" : null);
  if (!metricName) return null;

  const score = numberField(value, "cv_score")
    ?? numberField(value, "metric_value")
    ?? numberField(value, "score")
    ?? numberField(value, metricName)
    ?? numberField(allMetrics, metricName);
  if (score === null) return null;

  const experimentId = stringField(value, "experiment_id") ?? fallback.experiment_id;
  const competition = stringField(value, "competition") ?? fallback.competition;
  if (!experimentId || !competition) return null;

  const direction = normalizeMetricDirection(
    stringField(value, "direction") ?? stringField(value, "metric_direction"),
    metricName,
  );
  const createdAt = normalizeDateTime(
    stringField(value, "created_at")
      ?? stringField(value, "finished_at_utc")
      ?? stringField(value, "started_at_utc")
      ?? fallback.created_at,
  ) ?? new Date().toISOString();
  const logPath = stringFieldFromArtifacts(value, "log")
    ?? stringField(value, "train_log")
    ?? fallback.log_path
    ?? `experiments/${experimentId}/train.log`;

  const artifacts: KaggleMetrics["artifacts"] = { log: logPath };
  const submission = stringFieldFromArtifacts(value, "submission")
    ?? stringField(value, "submission_file")
    ?? fallback.submission_path;
  if (submission) artifacts.submission = submission;
  const model = stringFieldFromArtifacts(value, "model")
    ?? stringField(value, "model_file")
    ?? fallback.model_path;
  if (model) artifacts.model = model;

  const warnings: string[] = [];
  if (!stringField(value, "competition")) warnings.push("competition was supplied by the caller");
  if (!stringField(value, "direction") && !stringField(value, "metric_direction")) {
    warnings.push(`direction inferred as ${direction} for metric ${metricName}`);
  }
  if (numberField(value, "train_rows") === null) warnings.push("train_rows missing; normalized to 0");
  if (numberField(value, "valid_rows") === null) warnings.push("valid_rows missing; normalized to 0");

  return {
    metrics: {
      experiment_id: experimentId,
      competition,
      metric_name: metricName,
      direction,
      cv_score: score,
      cv_std: numberField(value, "cv_std") ?? stdFromFoldScores(value["fold_scores"]),
      holdout_score: numberField(value, "holdout_score"),
      train_rows: intField(value, "train_rows") ?? 0,
      valid_rows: intField(value, "valid_rows") ?? 0,
      seed: intField(value, "seed") ?? 0,
      created_at: createdAt,
      status: normalizeStatus(stringField(value, "status")),
      artifacts,
    },
    warnings,
  };
}

function normalizeMetricDirection(value: string | null, metricName: string): KaggleMetrics["direction"] {
  if (value === "maximize" || value === "higher" || value === "higher_is_better" || value === "greater_is_better") return "maximize";
  if (value === "minimize" || value === "lower" || value === "lower_is_better" || value === "less_is_better") return "minimize";
  return metricName === "rmse" || metricName === "log_loss" ? "minimize" : "maximize";
}

function normalizeStatus(value: string | null): KaggleMetrics["status"] {
  if (value === "running" || value === "completed" || value === "failed") return value;
  if (value === "succeeded" || value === "success" || value === "complete") return "completed";
  if (value === "error") return "failed";
  return "completed";
}

function normalizeDateTime(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function firstNumericMetricName(value: Record<string, unknown> | null): string | null {
  if (!value) return null;
  for (const preferred of ["balanced_accuracy", "accuracy", "macro_f1", "weighted_f1", "log_loss", "rmse"]) {
    if (numberField(value, preferred) !== null) return preferred;
  }
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "number" && Number.isFinite(field)) return key;
  }
  return null;
}

function stdFromFoldScores(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  const scores = value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
  if (scores.length < 2) return null;
  const mean = scores.reduce((total, item) => total + item, 0) / scores.length;
  const variance = scores.reduce((total, item) => total + (item - mean) ** 2, 0) / (scores.length - 1);
  return Math.sqrt(variance);
}

function stringFieldFromArtifacts(value: Record<string, unknown>, key: string): string | null {
  const artifacts = value["artifacts"];
  return isRecord(artifacts) ? stringField(artifacts, key) : null;
}

function stringField(value: Record<string, unknown> | null, key: string): string | null {
  const field = value?.[key];
  return typeof field === "string" && field.trim().length > 0 ? field : null;
}

function numberField(value: Record<string, unknown> | null, key: string): number | null {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : null;
}

function intField(value: Record<string, unknown>, key: string): number | null {
  const field = numberField(value, key);
  return field !== null && Number.isInteger(field) ? field : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
