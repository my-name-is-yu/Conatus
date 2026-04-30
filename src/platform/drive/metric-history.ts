export type MetricDirection = "maximize" | "minimize";

export type MetricTrend = "improving" | "stalled" | "noisy" | "regressing" | "breakthrough";

export interface MetricObservationSource {
  entry_id: string;
  kind: string;
  summary?: string;
  metric_source?: string;
  artifacts?: Array<{ label: string; path?: string; state_relative_path?: string; url?: string }>;
  raw_refs?: Array<{ kind: string; id?: string; path?: string; state_relative_path?: string; url?: string }>;
}

export interface MetricObservation {
  observed_at: string;
  metric_key: string;
  value: number;
  direction: MetricDirection;
  confidence: number;
  source: MetricObservationSource;
}

export interface MetricTrendContext {
  metric_key: string;
  direction: MetricDirection;
  trend: MetricTrend;
  latest_value: number;
  latest_observed_at: string;
  best_value: number;
  best_observed_at: string;
  observation_count: number;
  recent_slope_per_observation: number;
  best_delta: number;
  last_meaningful_improvement_delta: number | null;
  last_breakthrough_delta: number | null;
  time_since_last_meaningful_improvement_ms: number | null;
  improvement_threshold: number;
  breakthrough_threshold: number;
  noise_band: number;
  confidence: number;
  source_refs: MetricObservationSource[];
  summary: string;
}

export interface MetricTrendClassificationOptions {
  improvementThreshold?: number;
  breakthroughThreshold?: number;
  noiseBand?: number;
  now?: Date;
  recentWindowSize?: number;
}

const DEFAULT_IMPROVEMENT_THRESHOLD = 0.01;
const DEFAULT_BREAKTHROUGH_THRESHOLD = 0.05;
const DEFAULT_NOISE_BAND = 0.005;
const DEFAULT_RECENT_WINDOW_SIZE = 5;

export function classifyMetricTrend(
  observations: MetricObservation[],
  options: MetricTrendClassificationOptions = {}
): MetricTrendContext | null {
  const sorted = observations
    .filter((observation) => Number.isFinite(observation.value))
    .sort((left, right) => left.observed_at.localeCompare(right.observed_at));
  if (sorted.length === 0) return null;

  const metricKey = sorted[0]!.metric_key;
  const direction = sorted[0]!.direction;
  const sameMetric = sorted.filter((observation) =>
    observation.metric_key === metricKey && observation.direction === direction
  );
  if (sameMetric.length === 0) return null;

  const improvementThreshold = options.improvementThreshold ?? DEFAULT_IMPROVEMENT_THRESHOLD;
  const breakthroughThreshold = options.breakthroughThreshold ?? DEFAULT_BREAKTHROUGH_THRESHOLD;
  const noiseBand = options.noiseBand ?? DEFAULT_NOISE_BAND;
  const now = options.now ?? new Date();
  const recentWindowSize = options.recentWindowSize ?? DEFAULT_RECENT_WINDOW_SIZE;
  const normalized = sameMetric.map((observation) => normalizeValue(observation.value, direction));
  const firstNormalized = normalized[0]!;
  const latest = sameMetric[sameMetric.length - 1]!;
  const latestNormalized = normalized[normalized.length - 1]!;
  const bestIndex = indexOfMax(normalized);
  const best = sameMetric[bestIndex]!;
  const bestNormalized = normalized[bestIndex]!;
  const previousBestNormalized = normalized.length > 1
    ? Math.max(...normalized.slice(0, -1))
    : firstNormalized;
  const latestBestDelta = latestNormalized - previousBestNormalized;
  const latestDeltaFromBest = latestNormalized - bestNormalized;
  const bestDelta = bestNormalized - firstNormalized;
  const recentNormalized = normalized.slice(-recentWindowSize);
  const recentSlope = linearSlope(recentNormalized);
  const minRecent = Math.min(...recentNormalized);
  const maxRecent = Math.max(...recentNormalized);
  const recentRange = maxRecent - minRecent;
  const latestDeltaFromFirst = latestNormalized - firstNormalized;
  const meaningfulDeltas = normalized
    .slice(1)
    .map((value, index) => ({
      delta: value - normalized[index]!,
      observedAt: sameMetric[index + 1]!.observed_at,
      observedIndex: index + 1,
    }))
    .filter((entry) => entry.delta >= improvementThreshold);
  const breakthroughDeltas = normalized
    .slice(1)
    .map((value, index) => value - normalized[index]!)
    .filter((delta) => delta >= breakthroughThreshold);
  const lastMeaningfulImprovement = meaningfulDeltas[meaningfulDeltas.length - 1] ?? null;
  const postImprovementValues = lastMeaningfulImprovement
    ? normalized.slice(lastMeaningfulImprovement.observedIndex)
    : normalized;
  const postImprovementRange = postImprovementValues.length > 0
    ? Math.max(...postImprovementValues) - Math.min(...postImprovementValues)
    : 0;
  const observationsSinceLastMeaningfulImprovement = lastMeaningfulImprovement
    ? (normalized.length - 1) - lastMeaningfulImprovement.observedIndex
    : null;
  const timeSinceLastMeaningfulImprovementMs = lastMeaningfulImprovement
    ? Math.max(0, now.getTime() - Date.parse(lastMeaningfulImprovement.observedAt))
    : null;

  const trend = classifyTrend({
    count: sameMetric.length,
    latestBestDelta,
    latestDeltaFromBest,
    latestDeltaFromFirst,
    bestDelta,
    recentSlope,
    recentRange,
    postImprovementRange,
    observationsSinceLastMeaningfulImprovement,
    improvementThreshold,
    breakthroughThreshold,
    noiseBand,
  });
  const confidence = computeConfidence(sameMetric, trend, recentRange, noiseBand);
  const context: MetricTrendContext = {
    metric_key: metricKey,
    direction,
    trend,
    latest_value: latest.value,
    latest_observed_at: latest.observed_at,
    best_value: best.value,
    best_observed_at: best.observed_at,
    observation_count: sameMetric.length,
    recent_slope_per_observation: denormalizeDelta(recentSlope, direction),
    best_delta: denormalizeDelta(bestDelta, direction),
    last_meaningful_improvement_delta: lastMeaningfulImprovement
      ? denormalizeDelta(lastMeaningfulImprovement.delta, direction)
      : null,
    last_breakthrough_delta: breakthroughDeltas.length > 0
      ? denormalizeDelta(breakthroughDeltas[breakthroughDeltas.length - 1]!, direction)
      : null,
    time_since_last_meaningful_improvement_ms: timeSinceLastMeaningfulImprovementMs,
    improvement_threshold: denormalizeDelta(improvementThreshold, direction),
    breakthrough_threshold: denormalizeDelta(breakthroughThreshold, direction),
    noise_band: denormalizeDelta(noiseBand, direction),
    confidence,
    source_refs: sameMetric.slice(-recentWindowSize).map((observation) => observation.source),
    summary: buildMetricTrendSummary(metricKey, trend, latest.value, best.value, sameMetric.length),
  };
  return context;
}

export function summarizeMetricTrends(
  observations: MetricObservation[],
  options: MetricTrendClassificationOptions = {}
): MetricTrendContext[] {
  const groups = new Map<string, MetricObservation[]>();
  for (const observation of observations) {
    const key = `${observation.metric_key}\0${observation.direction}`;
    const existing = groups.get(key) ?? [];
    existing.push(observation);
    groups.set(key, existing);
  }
  return [...groups.values()]
    .map((group) => classifyMetricTrend(group, options))
    .filter((trend): trend is MetricTrendContext => trend !== null);
}

export function formatMetricTrendContext(context: MetricTrendContext): string {
  const since = context.time_since_last_meaningful_improvement_ms === null
    ? "no meaningful improvement recorded"
    : `${Math.round(context.time_since_last_meaningful_improvement_ms / 60_000)}m since meaningful improvement`;
  return `${context.metric_key} ${context.trend}: latest=${context.latest_value}, best=${context.best_value}, slope=${roundMetric(context.recent_slope_per_observation)}, ${since}`;
}

function classifyTrend(input: {
  count: number;
  latestBestDelta: number;
  latestDeltaFromBest: number;
  latestDeltaFromFirst: number;
  bestDelta: number;
  recentSlope: number;
  recentRange: number;
  postImprovementRange: number;
  observationsSinceLastMeaningfulImprovement: number | null;
  improvementThreshold: number;
  breakthroughThreshold: number;
  noiseBand: number;
}): MetricTrend {
  if (input.count < 2) return "noisy";
  if (input.latestBestDelta >= input.breakthroughThreshold) return "breakthrough";
  if (input.latestBestDelta >= input.improvementThreshold) return "improving";
  if (input.latestDeltaFromBest <= -input.improvementThreshold) {
    return "regressing";
  }
  if (
    input.observationsSinceLastMeaningfulImprovement !== null
    && input.observationsSinceLastMeaningfulImprovement >= 2
    && input.postImprovementRange <= input.noiseBand
  ) {
    return "stalled";
  }
  if (input.latestDeltaFromFirst <= -input.improvementThreshold || input.recentSlope <= -input.improvementThreshold) {
    return "regressing";
  }
  if (input.recentSlope >= input.improvementThreshold) {
    return "improving";
  }
  if (input.recentRange === 0 || input.recentRange <= Number.EPSILON) return "stalled";
  if (input.recentRange <= input.noiseBand || Math.abs(input.recentSlope) < input.noiseBand) {
    return input.bestDelta >= input.improvementThreshold ? "stalled" : "noisy";
  }
  if (input.bestDelta < input.improvementThreshold) return "stalled";
  return "noisy";
}

function computeConfidence(
  observations: MetricObservation[],
  trend: MetricTrend,
  recentRange: number,
  noiseBand: number
): number {
  const meanObservationConfidence = observations.reduce((sum, observation) => sum + observation.confidence, 0) / observations.length;
  const sampleConfidence = Math.min(1, observations.length / 5);
  const trendConfidence = trend === "noisy"
    ? Math.max(0.35, Math.min(0.75, noiseBand / Math.max(recentRange, Number.EPSILON)))
    : 1;
  return clamp01(meanObservationConfidence * sampleConfidence * trendConfidence);
}

function normalizeValue(value: number, direction: MetricDirection): number {
  return direction === "maximize" ? value : -value;
}

function denormalizeDelta(delta: number, direction: MetricDirection): number {
  return direction === "maximize" ? delta : -delta;
}

function indexOfMax(values: number[]): number {
  let bestIndex = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index]! > values[bestIndex]!) bestIndex = index;
  }
  return bestIndex;
}

function linearSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let index = 0; index < n; index += 1) {
    const value = values[index]!;
    sumX += index;
    sumY += value;
    sumXY += index * value;
    sumXX += index * index;
  }
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return 0;
  return (n * sumXY - sumX * sumY) / denominator;
}

function buildMetricTrendSummary(
  metricKey: string,
  trend: MetricTrend,
  latestValue: number,
  bestValue: number,
  observationCount: number
): string {
  return `${metricKey} trend is ${trend} from ${observationCount} observation(s); latest=${latestValue}, best=${bestValue}`;
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
