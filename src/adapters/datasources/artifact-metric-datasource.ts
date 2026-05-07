import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Dirent } from "node:fs";
import type {
  DataSourceConfig,
  DataSourceQuery,
  DataSourceResult,
  DataSourceType,
} from "../../base/types/data-source.js";
import type { IDataSourceAdapter } from "../../platform/observation/data-source-adapter.js";

type Aggregation = "max" | "min" | "count" | "file_count";
type CurrentProgressPolicy = "legacy" | "completed_fresh_only" | "allow_live";
type ArtifactLifecycleState = "completed" | "running" | "failed" | "unknown";
type FreshnessScope = "none" | "goal" | "task" | "run";
type FreshnessStatus = "fresh" | "stale" | "pre_scope";

export interface ArtifactMetricFreshnessScope {
  freshAfterTime: string;
  freshnessScope: Exclude<FreshnessScope, "none">;
  freshnessScopeId: string;
}

interface MetricExtraction {
  key: string;
  keyPath: string;
  value: number;
  confidence: number;
}

interface MetricCandidate {
  path: string;
  relativePath: string;
  updatedTime: string;
  artifactAgeMs: number;
  candidateScore: number;
  reasons: string[];
  stale: boolean;
  freshnessStatus: FreshnessStatus;
  currentRun: boolean | null;
  freshnessScope: FreshnessScope;
  freshnessScopeId: string | null;
}

interface MetricObservation extends MetricCandidate {
  parser: "json";
  metrics: MetricExtraction[];
  extractionConfidence: number;
  lifecycle: ArtifactLifecycle;
  eligibleForCurrentProgress: boolean;
  ineligibleReason: string | null;
}

interface SelectedMetric {
  path: string;
  relativePath: string;
  key: string;
  keyPath: string;
  value: number;
  parser: "json";
  updatedTime: string;
  artifactAgeMs: number;
  extractionConfidence: number;
  candidateScore: number;
  stale: boolean;
  freshnessStatus: FreshnessStatus;
  currentRun: boolean | null;
  freshnessScope: FreshnessScope;
  freshnessScopeId: string | null;
}

interface MetricConflict {
  metricKey: string;
  candidates: Array<{
    path: string;
    keyPath: string;
    value: number;
    updatedTime: string;
    artifactAgeMs: number;
    extractionConfidence: number;
    stale: boolean;
    freshnessStatus: FreshnessStatus;
    currentRun: boolean | null;
  }>;
}

interface ArtifactLifecycle {
  state: ArtifactLifecycleState;
  status: string | null;
  success: boolean | null;
}

interface MetricObservationSnapshot {
  candidates: MetricCandidate[];
  observations: MetricObservation[];
}

const BUILTIN_SOURCE_ID = "ds_builtin_workspace_artifacts";
const DEFAULT_METRIC_FILE_NAMES = ["metrics.json", "result.json"];
const DEFAULT_ARTIFACT_ROOTS = ["artifacts", "experiments", "runs", "reports", "outputs", "results", "logs"];
const DEFAULT_EXCLUDE_DIRS = new Set([
  ".cache",
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".venv",
  "__pycache__",
  "env",
  "node_modules",
  "venv",
]);
const DEFAULT_EXCLUDE_PATHS = new Set(["data/raw"]);
const DEFAULT_MAX_METRIC_FILES = 5_000;
const DEFAULT_MAX_ARTIFACT_FILES = 100_000;
const DEFAULT_MAX_CANDIDATES = 200;
const DEFAULT_GOAL_SCOPED_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_RAW_CANDIDATES = 25;

export function createWorkspaceArtifactMetricDataSource(workspacePath = process.cwd()): ArtifactMetricDataSourceAdapter {
  return new ArtifactMetricDataSourceAdapter({
    id: BUILTIN_SOURCE_ID,
    name: "builtin:workspace artifact metrics",
    type: "artifact_metric",
    connection: { path: workspacePath },
    enabled: true,
    created_at: new Date().toISOString(),
  });
}

export function createGoalWorkspaceArtifactMetricDataSource(
  goalId: string,
  workspacePath: string,
  dimensionMetrics: Record<string, string[]>,
  dimensionAggregations: Record<string, Aggregation> = {},
  freshnessScope?: ArtifactMetricFreshnessScope,
): ArtifactMetricDataSourceAdapter {
  return new ArtifactMetricDataSourceAdapter({
    id: `${BUILTIN_SOURCE_ID}:goal:${goalId}`,
    name: "builtin:goal workspace artifact metrics",
    type: "artifact_metric",
    connection: {
      path: workspacePath,
      dimension_metrics: dimensionMetrics,
      dimension_aggregations: dimensionAggregations,
      require_metric_match: true,
      stale_after_ms: DEFAULT_GOAL_SCOPED_STALE_AFTER_MS,
      ...(freshnessScope
        ? {
            fresh_after_time: freshnessScope.freshAfterTime,
            freshness_scope: freshnessScope.freshnessScope,
            freshness_scope_id: freshnessScope.freshnessScopeId,
          }
        : {}),
      current_progress_policy: "completed_fresh_only",
    },
    enabled: true,
    created_at: new Date().toISOString(),
    scope_goal_id: goalId,
  });
}

export class ArtifactMetricDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceId: string;
  readonly sourceType: DataSourceType = "artifact_metric";
  readonly config: DataSourceConfig;
  private observationPassCache: Map<string, MetricObservationSnapshot> | null = null;

  constructor(config: DataSourceConfig) {
    this.config = config;
    this.sourceId = config.id;
  }

  async connect(): Promise<void> {
    await fs.access(this.workspaceRoot());
  }

  async disconnect(): Promise<void> {
    // no persistent connection
  }

  async healthCheck(): Promise<boolean> {
    try {
      await fs.access(this.workspaceRoot());
      return true;
    } catch {
      return false;
    }
  }

  beginObservationPass(): void {
    this.observationPassCache = new Map();
  }

  endObservationPass(): void {
    this.observationPassCache = null;
  }

  getSupportedDimensions(): string[] {
    const dimensions = new Set<string>([
      ...Object.keys(this.config.dimension_mapping ?? {}),
      ...Object.keys(this.config.connection.dimension_metrics ?? {}),
      ...Object.keys(this.config.connection.dimension_aggregations ?? {}),
      "validated_experiment_count",
      "durable_artifact_count",
    ]);
    return Array.from(dimensions).sort();
  }

  supportsDimension(dimensionName: string): boolean {
    return this.getSupportedDimensions().includes(dimensionName) || isRecognizedBestMetricDimension(dimensionName);
  }

  async query(params: DataSourceQuery): Promise<DataSourceResult> {
    const root = this.workspaceRoot();
    const expression = this.config.dimension_mapping?.[params.dimension_name] ?? params.expression;
    const aggregation = resolveAggregation(params.dimension_name, expression, this.config);
    const timestamp = new Date().toISOString();
    const options = this.scanOptions();

    if (aggregation === "file_count") {
      const count = await countArtifactFiles(root, options);
      return {
        value: count,
        raw: {
          root,
          aggregation,
          file_count: count,
          discovery: discoveryRaw(options),
          freshness: freshnessRaw(options, null, [], "file_count"),
        },
        timestamp,
        source_id: this.sourceId,
      };
    }

    const keys = resolveMetricKeys(params.dimension_name, expression, this.config);
    const snapshot = await this.readMetricObservationsForPass(root, options);
    const observations = snapshot.observations;
    const candidates = selectCandidatesForKeys(snapshot.candidates, keys, options);
    const evidenceCandidates = buildEvidenceCandidates(observations, keys, aggregation === "min" ? "min" : "max");

    if (aggregation === "count") {
      const matched = observations.filter((observation) => observation.eligibleForCurrentProgress && hasAnyMetric(observation, keys));
      return {
        value: matched.length,
        raw: {
          root,
          aggregation,
          inspected_metric_files: candidates.length,
          matched_metric_files: matched.length,
          metric_keys: keys,
          discovery: discoveryRaw(options),
          freshness: freshnessRaw(options, null, observations, matched.length > 0 ? "eligible" : "missing"),
          candidates: rawCandidates(candidates),
          evidence_candidates: evidenceCandidates,
          conflicts: detectMetricConflicts(params.dimension_name, observations, keys),
          stale_candidates: staleRaw(observations),
          ineligible_candidates: ineligibleRaw(observations),
          strategic_correctness: "not_evaluated",
        },
        timestamp,
        source_id: this.sourceId,
      };
    }

    const match = selectMetric(observations, keys, aggregation);
    if (this.config.connection.require_metric_match && match === null) {
      if (hasCurrentScopeStaleMetricMatch(observations, keys, options)) {
        return {
          value: 0,
          raw: {
            root,
            aggregation,
            inspected_metric_files: candidates.length,
            metric_keys: keys,
            selected_path: null,
            selected_key: null,
            selected_value: 0,
            selected: null,
            discovery: discoveryRaw(options),
            freshness: freshnessRaw(options, null, observations, "ineligible_artifact_metrics_only"),
            candidates: rawCandidates(candidates),
            evidence_candidates: evidenceCandidates,
            conflicts: detectMetricConflicts(params.dimension_name, observations, keys),
            stale_candidates: staleRaw(observations),
            ineligible_candidates: ineligibleRaw(observations),
            strategic_correctness: "not_evaluated",
          },
          timestamp,
          source_id: this.sourceId,
          metadata: {
            confidence: 0.35,
            confidence_reason: "Only stale or pre-scope artifact metrics matched the current progress datasource query.",
          },
        };
      }
      throw new Error(`No artifact metric found for dimension "${params.dimension_name}" using keys [${keys.join(", ")}]`);
    }
    return {
      value: match?.value ?? 0,
      raw: {
        root,
        aggregation,
        inspected_metric_files: candidates.length,
        metric_keys: keys,
        selected_path: match?.path ?? null,
        selected_key: match?.key ?? null,
        selected_value: match?.value ?? 0,
        selected: match,
        discovery: discoveryRaw(options),
        freshness: freshnessRaw(options, match, observations, match ? "eligible" : "missing"),
        candidates: rawCandidates(candidates),
        evidence_candidates: evidenceCandidates,
        conflicts: detectMetricConflicts(params.dimension_name, observations, keys),
        stale_candidates: staleRaw(observations),
        ineligible_candidates: ineligibleRaw(observations),
        strategic_correctness: "not_evaluated",
      },
      timestamp,
      source_id: this.sourceId,
    };
  }

  private workspaceRoot(): string {
    const configuredPath = this.config.connection.path;
    return configuredPath ? path.resolve(configuredPath) : process.cwd();
  }

  private scanOptions(): ScanOptions {
    return {
      metricFileNames: new Set(this.config.connection.metric_file_names ?? DEFAULT_METRIC_FILE_NAMES),
      artifactRoots: unique([
        ...(this.config.connection.artifact_roots ?? []),
        ...(this.config.connection.artifact_roots ? [] : DEFAULT_ARTIFACT_ROOTS),
      ].map(normalizeRelativePath)),
      includePaths: unique((this.config.connection.include_paths ?? []).map(normalizeRelativePath)),
      parserHints: new Set(this.config.connection.parser_hints ?? ["json"]),
      excludeDirs: new Set([...(this.config.connection.exclude_dirs ?? []), ...DEFAULT_EXCLUDE_DIRS]),
      excludePaths: new Set([
        ...Array.from(DEFAULT_EXCLUDE_PATHS),
        ...(this.config.connection.exclude_paths ?? []),
      ].map(normalizeRelativePath)),
      maxMetricFiles: this.config.connection.max_metric_files ?? DEFAULT_MAX_METRIC_FILES,
      maxArtifactFiles: this.config.connection.max_artifact_files ?? DEFAULT_MAX_ARTIFACT_FILES,
      maxCandidates: this.config.connection.max_candidates ?? DEFAULT_MAX_CANDIDATES,
      staleAfterMs: this.config.connection.stale_after_ms,
      currentProgressPolicy: this.config.connection.current_progress_policy ?? "legacy",
      freshAfterTime: this.config.connection.fresh_after_time,
      freshAfterMs: parseIsoMs(this.config.connection.fresh_after_time),
      freshnessScope: this.config.connection.freshness_scope ?? "none",
      freshnessScopeId: this.config.connection.freshness_scope_id,
      nowMs: Date.now(),
    };
  }

  private async readMetricObservationsForPass(root: string, options: ScanOptions): Promise<MetricObservationSnapshot> {
    const cacheKey = scanCacheKey(root, options);
    const cached = this.observationPassCache?.get(cacheKey);
    if (cached) return cached;

    const candidates = await discoverMetricCandidates(root, options, []);
    const observations = await readMetricObservations(candidates, options);
    const snapshot = { candidates, observations };
    this.observationPassCache?.set(cacheKey, snapshot);
    return snapshot;
  }
}

interface ScanOptions {
  metricFileNames: Set<string>;
  artifactRoots: string[];
  includePaths: string[];
  parserHints: Set<string>;
  excludeDirs: Set<string>;
  excludePaths: Set<string>;
  maxMetricFiles: number;
  maxArtifactFiles: number;
  maxCandidates: number;
  staleAfterMs?: number;
  freshAfterTime?: string;
  freshAfterMs?: number;
  freshnessScope: FreshnessScope;
  freshnessScopeId?: string;
  currentProgressPolicy: CurrentProgressPolicy;
  nowMs: number;
}

async function discoverMetricCandidates(root: string, options: ScanOptions, keys: string[]): Promise<MetricCandidate[]> {
  const discovered = new Map<string, MetricCandidate>();

  for (const includePath of options.includePaths) {
    if (discovered.size >= options.maxMetricFiles) break;
    const absolute = path.resolve(root, includePath);
    if (!isInsideRoot(root, absolute) || !(await isFile(absolute))) continue;
    if (!options.metricFileNames.has(path.basename(absolute))) continue;
    const candidate = await buildMetricCandidate(root, absolute, options, keys);
    discovered.set(candidate.path, candidate);
  }

  const searchRoots = await resolveSearchRoots(root, options);

  for (const searchRoot of searchRoots) {
    if (discovered.size >= options.maxMetricFiles) break;
    await walkFiles(root, searchRoot, options, async (filePath) => {
      if (discovered.size >= options.maxMetricFiles) return;
      if (!options.metricFileNames.has(path.basename(filePath))) return;
      const candidate = await buildMetricCandidate(root, filePath, options, keys);
      discovered.set(candidate.path, candidate);
    });
  }

  return Array.from(discovered.values())
    .sort(compareCandidates)
    .slice(0, keys.length === 0 ? options.maxMetricFiles : options.maxCandidates);
}

function selectCandidatesForKeys(
  candidates: MetricCandidate[],
  keys: string[],
  options: ScanOptions,
): MetricCandidate[] {
  return candidates
    .map((candidate) => applyMetricKeyScore(candidate, keys))
    .sort(compareCandidates)
    .slice(0, options.maxCandidates);
}

function applyMetricKeyScore<T extends MetricCandidate>(candidate: T, keys: string[]): T {
  let score = candidate.candidateScore;
  const reasons = [...candidate.reasons];
  for (const key of keys) {
    if (candidate.relativePath.toLowerCase().includes(key.toLowerCase())) {
      score += 8;
      reasons.push(`path metric hint: ${key}`);
      break;
    }
  }
  return { ...candidate, candidateScore: score, reasons };
}

function scanCacheKey(root: string, options: ScanOptions): string {
  return JSON.stringify({
    root,
    metricFileNames: [...options.metricFileNames].sort(),
    artifactRoots: options.artifactRoots,
    includePaths: options.includePaths,
    parserHints: [...options.parserHints].sort(),
    excludeDirs: [...options.excludeDirs].sort(),
    excludePaths: [...options.excludePaths].sort(),
    maxMetricFiles: options.maxMetricFiles,
    maxArtifactFiles: options.maxArtifactFiles,
    maxCandidates: options.maxCandidates,
    staleAfterMs: options.staleAfterMs,
    freshAfterTime: options.freshAfterTime,
    freshnessScope: options.freshnessScope,
    freshnessScopeId: options.freshnessScopeId,
    currentProgressPolicy: options.currentProgressPolicy,
  });
}

async function resolveSearchRoots(root: string, options: ScanOptions): Promise<string[]> {
  const roots: string[] = [];
  for (const includePath of [...options.includePaths, ...options.artifactRoots]) {
    const absolute = path.resolve(root, includePath);
    if (!isInsideRoot(root, absolute)) continue;
    if (await isDirectory(absolute)) roots.push(absolute);
  }
  if (roots.length === 0) roots.push(root);
  return unique(roots);
}

async function buildMetricCandidate(root: string, filePath: string, options: ScanOptions, keys: string[]): Promise<MetricCandidate> {
  const stats = await fs.stat(filePath);
  const relativePath = normalizeRelativePath(path.relative(root, filePath));
  const reasons: string[] = [];
  let score = 0;

  if (options.metricFileNames.has(path.basename(filePath))) {
    score += 35;
    reasons.push("metric filename match");
  }
  const matchedRoot = options.artifactRoots.find((rootHint) => relativePath === rootHint || relativePath.startsWith(`${rootHint}/`));
  if (matchedRoot) {
    score += 20;
    reasons.push(`artifact root match: ${matchedRoot}`);
  }
  for (const key of keys) {
    if (relativePath.toLowerCase().includes(key.toLowerCase())) {
      score += 8;
      reasons.push(`path metric hint: ${key}`);
      break;
    }
  }
  const mtime = stats.mtime;
  const artifactAgeMs = Math.max(0, options.nowMs - mtime.getTime());
  if (artifactAgeMs < 24 * 60 * 60 * 1000) {
    score += 10;
    reasons.push("recent artifact");
  }
  const beforeFreshnessScope = options.freshAfterMs !== undefined && mtime.getTime() < options.freshAfterMs;
  const staleByAge = options.staleAfterMs !== undefined && artifactAgeMs > options.staleAfterMs;
  const stale = beforeFreshnessScope || staleByAge;
  const freshnessStatus: FreshnessStatus = beforeFreshnessScope ? "pre_scope" : staleByAge ? "stale" : "fresh";
  const currentRun = options.freshAfterMs === undefined ? null : !beforeFreshnessScope;
  if (stale) {
    score -= 30;
    reasons.push(beforeFreshnessScope
      ? `artifact precedes ${options.freshnessScope} freshness scope`
      : "stale artifact");
  }

  return {
    path: filePath,
    relativePath,
    updatedTime: mtime.toISOString(),
    artifactAgeMs,
    candidateScore: score,
    reasons,
    stale,
    freshnessStatus,
    currentRun,
    freshnessScope: options.freshnessScope,
    freshnessScopeId: options.freshnessScopeId ?? null,
  };
}

async function countArtifactFiles(root: string, options: ScanOptions): Promise<number> {
  let count = 0;
  await walkFiles(root, root, options, async () => {
    if (count < options.maxArtifactFiles) count += 1;
  });
  return count;
}

async function walkFiles(
  root: string,
  startDir: string,
  options: ScanOptions,
  onFile: (filePath: string) => Promise<void>,
): Promise<void> {
  async function visit(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = normalizeRelativePath(path.relative(root, fullPath));
      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entry.name, relPath, options)) continue;
        await visit(fullPath);
      } else if (entry.isFile()) {
        await onFile(fullPath);
      }
    }
  }

  await visit(startDir);
}

function shouldSkipDirectory(name: string, relPath: string, options: ScanOptions): boolean {
  if (options.excludeDirs.has(name)) return true;
  for (const excludedPath of options.excludePaths) {
    if (relPath === excludedPath || relPath.startsWith(`${excludedPath}/`)) return true;
  }
  return false;
}

async function readMetricObservations(candidates: MetricCandidate[], options: ScanOptions): Promise<MetricObservation[]> {
  const observations: MetricObservation[] = [];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await fs.readFile(candidate.path, "utf8")) as unknown;
      const metrics = extractNumericMetrics(parsed);
      if (metrics.length > 0) {
        const lifecycle = extractArtifactLifecycle(parsed);
        const ineligibleReason = currentProgressIneligibleReason(candidate, lifecycle, options);
        observations.push({
          ...candidate,
          parser: "json",
          metrics,
          extractionConfidence: Math.max(...metrics.map((metric) => metric.confidence)),
          lifecycle,
          eligibleForCurrentProgress: ineligibleReason === null,
          ineligibleReason,
        });
      }
    } catch {
      // Ignore incomplete or invalid artifacts while the long-running process is writing.
    }
  }
  return observations;
}

function extractNumericMetrics(value: unknown): MetricExtraction[] {
  const metrics: MetricExtraction[] = [];
  if (!isRecord(value)) return metrics;

  for (const [key, field] of Object.entries(value)) {
    addNumber(metrics, key, key, field, 0.95);
  }

  const nestedMetrics = value["metrics"];
  if (isRecord(nestedMetrics)) {
    for (const [key, field] of Object.entries(nestedMetrics)) {
      addNumber(metrics, key, `metrics.${key}`, field, 0.90);
    }
  }

  const allMetrics = value["all_metrics"];
  if (isRecord(allMetrics)) {
    for (const [key, field] of Object.entries(allMetrics)) {
      addNumber(metrics, key, `all_metrics.${key}`, field, 0.90);
    }
  }

  const metricName = typeof value["metric_name"] === "string" ? value["metric_name"] : null;
  if (metricName) {
    addNumber(metrics, metricName, "score", value["score"], 0.85);
    addNumber(metrics, metricName, "cv_score", value["cv_score"], 0.85);
  }

  const evidence = value["evidence"];
  if (Array.isArray(evidence)) {
    for (const [index, item] of evidence.entries()) {
      if (!isRecord(item)) continue;
      const label = typeof item["label"] === "string" ? item["label"] : null;
      if (!label) continue;
      addNumber(metrics, label, `evidence.${index}.value`, item["value"], 0.80);
    }
  }

  return metrics;
}

function extractArtifactLifecycle(value: unknown): ArtifactLifecycle {
  if (!isRecord(value)) return { state: "unknown", status: null, success: null };

  const status = typeof value["status"] === "string" ? value["status"] : null;
  const success = booleanOrNull(value["success"]);
  if (status === "running") return { state: "running", status, success };
  if (status === "failed") return { state: "failed", status, success };
  if (success === false) return { state: "failed", status, success };
  if (status === "completed") return { state: "completed", status, success };
  if (success === true) return { state: "completed", status, success };
  return { state: "unknown", status, success };
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function currentProgressIneligibleReason(
  candidate: MetricCandidate,
  lifecycle: ArtifactLifecycle,
  options: ScanOptions,
): string | null {
  if (options.currentProgressPolicy === "legacy") return null;
  if (candidate.freshnessStatus === "pre_scope") {
    return `artifact precedes ${candidate.freshnessScope} freshness scope`;
  }
  if (candidate.stale) return "artifact is stale for current progress";
  if (options.currentProgressPolicy === "allow_live") {
    return lifecycle.state === "completed" || lifecycle.state === "running"
      ? null
      : `artifact lifecycle is ${lifecycle.state}`;
  }
  return lifecycle.state === "completed"
    ? null
    : `artifact lifecycle is ${lifecycle.state}`;
}

function addNumber(metrics: MetricExtraction[], key: string, keyPath: string, value: unknown, confidence: number): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    metrics.push({ key, keyPath, value, confidence });
  }
}

function hasAnyMetric(observation: MetricObservation, keys: string[]): boolean {
  if (keys.length === 0) return observation.metrics.length > 0;
  return keys.some((key) => observation.metrics.some((metric) => metric.key === key));
}

function hasCurrentScopeStaleMetricMatch(observations: MetricObservation[], keys: string[], options: ScanOptions): boolean {
  if (options.freshnessScope === "none") return false;
  return observations.some((observation) => (
    observation.stale
    && !observation.eligibleForCurrentProgress
    && hasAnyMetric(observation, keys)
  ));
}

function selectMetric(
  observations: MetricObservation[],
  keys: string[],
  aggregation: "max" | "min",
): SelectedMetric | null {
  const matches = matchingMetrics(observations, keys);
  if (matches.length === 0) return null;
  const sorted = [...matches].sort((left, right) => compareMetricMatches(left, right, aggregation));
  const best = sorted[0]!;
  return {
    path: best.observation.path,
    relativePath: best.observation.relativePath,
    key: best.metric.key,
    keyPath: best.metric.keyPath,
    value: best.metric.value,
    parser: best.observation.parser,
    updatedTime: best.observation.updatedTime,
    artifactAgeMs: best.observation.artifactAgeMs,
    extractionConfidence: best.metric.confidence,
    candidateScore: best.observation.candidateScore,
    stale: best.observation.stale,
    freshnessStatus: best.observation.freshnessStatus,
    currentRun: best.observation.currentRun,
    freshnessScope: best.observation.freshnessScope,
    freshnessScopeId: best.observation.freshnessScopeId,
  };
}

function matchingMetrics(observations: MetricObservation[], keys: string[]): Array<{ observation: MetricObservation; metric: MetricExtraction }> {
  const wanted = new Set(keys);
  const matches: Array<{ observation: MetricObservation; metric: MetricExtraction }> = [];
  for (const observation of observations) {
    if (!observation.eligibleForCurrentProgress) continue;
    for (const metric of observation.metrics) {
      if (wanted.size === 0 || wanted.has(metric.key)) {
        matches.push({ observation, metric });
      }
    }
  }
  return matches;
}

function compareMetricMatches(
  left: { observation: MetricObservation; metric: MetricExtraction },
  right: { observation: MetricObservation; metric: MetricExtraction },
  aggregation: "max" | "min",
): number {
  const leftQuality = qualityBucket(left.observation, left.metric);
  const rightQuality = qualityBucket(right.observation, right.metric);
  if (leftQuality !== rightQuality) return rightQuality - leftQuality;

  if (left.metric.value !== right.metric.value) {
    return aggregation === "max"
      ? right.metric.value - left.metric.value
      : left.metric.value - right.metric.value;
  }
  if (left.metric.confidence !== right.metric.confidence) return right.metric.confidence - left.metric.confidence;
  if (left.observation.candidateScore !== right.observation.candidateScore) return right.observation.candidateScore - left.observation.candidateScore;
  return Date.parse(right.observation.updatedTime) - Date.parse(left.observation.updatedTime);
}

function qualityBucket(observation: MetricObservation, metric: MetricExtraction): number {
  if (observation.stale) return 0;
  if (metric.confidence < 0.85) return 1;
  return 2;
}

function detectMetricConflicts(dimensionName: string, observations: MetricObservation[], keys: string[]): MetricConflict[] {
  const grouped = new Map<string, Array<{ observation: MetricObservation; metric: MetricExtraction }>>();
  for (const match of matchingMetrics(observations, keys)) {
    const group = grouped.get(match.metric.key) ?? [];
    group.push(match);
    grouped.set(match.metric.key, group);
  }

  const conflicts: MetricConflict[] = [];
  for (const [metricKey, matches] of grouped) {
    const conflict = buildConflict(metricKey, matches);
    if (conflict) conflicts.push(conflict);
  }

  if (keys.length > 1) {
    const aliasConflict = buildConflict(`dimension:${dimensionName}`, matchingMetrics(observations, keys));
    if (aliasConflict) conflicts.push(aliasConflict);
  }
  return conflicts;
}

function buildConflict(metricKey: string, matches: Array<{ observation: MetricObservation; metric: MetricExtraction }>): MetricConflict | null {
  const values = new Set(matches.map((match) => match.metric.value));
  if (values.size <= 1) return null;
  return {
    metricKey,
    candidates: matches
      .sort((left, right) => Date.parse(right.observation.updatedTime) - Date.parse(left.observation.updatedTime))
      .slice(0, MAX_RAW_CANDIDATES)
      .map(({ observation, metric }) => ({
        path: observation.relativePath,
        keyPath: metric.keyPath,
        value: metric.value,
        updatedTime: observation.updatedTime,
        artifactAgeMs: observation.artifactAgeMs,
        extractionConfidence: metric.confidence,
        stale: observation.stale,
        freshnessStatus: observation.freshnessStatus,
        currentRun: observation.currentRun,
      })),
  };
}

function buildEvidenceCandidates(
  observations: MetricObservation[],
  keys: string[],
  aggregation: "max" | "min",
): Array<Record<string, unknown>> {
  return matchingMetrics(observations, keys)
    .sort((left, right) => compareMetricMatches(left, right, aggregation))
    .slice(0, MAX_RAW_CANDIDATES)
    .map(({ observation, metric }) => ({
      path: observation.relativePath,
      metric_key: metric.key,
      metric_key_path: metric.keyPath,
      value: metric.value,
      parser: observation.parser,
      updated_time: observation.updatedTime,
      artifact_age_ms: observation.artifactAgeMs,
      extraction_confidence: metric.confidence,
      candidate_score: observation.candidateScore,
      stale: observation.stale,
      freshness_status: observation.freshnessStatus,
      current_run: observation.currentRun,
      current_progress_eligible: observation.eligibleForCurrentProgress,
      reasons: observation.reasons,
      strategic_correctness: "not_evaluated",
    }));
}

function rawCandidates(candidates: MetricCandidate[]): Array<Record<string, unknown>> {
  return candidates.slice(0, MAX_RAW_CANDIDATES).map((candidate) => ({
    path: candidate.relativePath,
    updated_time: candidate.updatedTime,
    artifact_age_ms: candidate.artifactAgeMs,
    candidate_score: candidate.candidateScore,
    stale: candidate.stale,
    freshness_status: candidate.freshnessStatus,
    current_run: candidate.currentRun,
    freshness_scope: candidate.freshnessScope,
    freshness_scope_id: candidate.freshnessScopeId,
    reasons: candidate.reasons,
  }));
}

function staleRaw(observations: MetricObservation[]): Array<Record<string, unknown>> {
  return observations
    .filter((observation) => observation.stale)
    .slice(0, MAX_RAW_CANDIDATES)
    .map((observation) => ({
      path: observation.relativePath,
      updated_time: observation.updatedTime,
      artifact_age_ms: observation.artifactAgeMs,
      extraction_confidence: observation.extractionConfidence,
      freshness_status: observation.freshnessStatus,
      current_run: observation.currentRun,
    }));
}

function ineligibleRaw(observations: MetricObservation[]): Array<Record<string, unknown>> {
  return observations
    .filter((observation) => !observation.eligibleForCurrentProgress)
    .slice(0, MAX_RAW_CANDIDATES)
    .map((observation) => ({
      path: observation.relativePath,
      updated_time: observation.updatedTime,
      artifact_age_ms: observation.artifactAgeMs,
      stale: observation.stale,
      freshness_status: observation.freshnessStatus,
      current_run: observation.currentRun,
      freshness_scope: observation.freshnessScope,
      freshness_scope_id: observation.freshnessScopeId,
      lifecycle_state: observation.lifecycle.state,
      lifecycle_status: observation.lifecycle.status,
      success: observation.lifecycle.success,
      reason: observation.ineligibleReason,
    }));
}

function discoveryRaw(options: ScanOptions): Record<string, unknown> {
  return {
    artifact_roots: options.artifactRoots,
    include_paths: options.includePaths,
    metric_file_names: Array.from(options.metricFileNames),
    max_metric_files: options.maxMetricFiles,
    max_candidates: options.maxCandidates,
    parser_hints: Array.from(options.parserHints),
    stale_after_ms: options.staleAfterMs ?? null,
    fresh_after_time: options.freshAfterTime ?? null,
    freshness_scope: options.freshnessScope,
    freshness_scope_id: options.freshnessScopeId ?? null,
    current_progress_policy: options.currentProgressPolicy,
  };
}

function freshnessRaw(
  options: ScanOptions,
  match: SelectedMetric | null,
  observations: MetricObservation[],
  currentProgressStatus: string,
): Record<string, unknown> {
  return {
    scope: options.freshnessScope,
    scope_id: options.freshnessScopeId ?? null,
    fresh_after_time: options.freshAfterTime ?? null,
    selected_path: match?.relativePath ?? null,
    selected_artifact_age_ms: match?.artifactAgeMs ?? null,
    selected_freshness_status: match?.freshnessStatus ?? null,
    selected_current_run: match?.currentRun ?? null,
    current_progress_status: currentProgressStatus,
    ineligible_candidate_count: observations.filter((observation) => !observation.eligibleForCurrentProgress).length,
  };
}

function compareCandidates(left: MetricCandidate, right: MetricCandidate): number {
  if (left.candidateScore !== right.candidateScore) return right.candidateScore - left.candidateScore;
  return Date.parse(right.updatedTime) - Date.parse(left.updatedTime);
}

function resolveAggregation(dimensionName: string, expression: string | undefined, config: DataSourceConfig): Aggregation {
  const configured = config.connection.dimension_aggregations?.[dimensionName];
  if (configured) return configured;
  if (expression?.startsWith("min:")) return "min";
  if (expression?.startsWith("max:")) return "max";
  if (expression?.startsWith("count:") || expression === "count_valid_metrics") return "count";
  if (expression === "file_count") return "file_count";
  if (dimensionName === "durable_artifact_count") return "file_count";
  if (dimensionName.endsWith("_count")) return "count";
  return prefersLowerMetric(dimensionName) ? "min" : "max";
}

function resolveMetricKeys(dimensionName: string, expression: string | undefined, config: DataSourceConfig): string[] {
  const configured = config.connection.dimension_metrics?.[dimensionName];
  if (configured && configured.length > 0) return unique(configured);

  if (expression) {
    const [, rest] = /^(?:min|max|count):(.*)$/.exec(expression) ?? [];
    const raw = rest ?? (expression === "count_valid_metrics" || expression === "file_count" ? "" : expression);
    const keys = raw.split(",").map((item) => item.trim()).filter(Boolean);
    if (keys.length > 0) return unique(keys);
  }

  if (dimensionName.endsWith("_count")) return [];

  return deriveMetricKeys(dimensionName);
}

function deriveMetricKeys(dimensionName: string): string[] {
  const keys = new Set<string>([dimensionName]);
  const withoutBest = dimensionName.startsWith("best_") ? dimensionName.slice("best_".length) : dimensionName;
  keys.add(withoutBest);

  for (const prefix of ["oof_", "cv_", "mean_", "best_"]) {
    if (withoutBest.startsWith(prefix)) {
      keys.add(withoutBest.slice(prefix.length));
    }
  }

  if (withoutBest.includes("balanced_accuracy")) {
    keys.add("balanced_accuracy");
    keys.add("oof_balanced_accuracy");
    keys.add("cv_balanced_accuracy");
  }
  if (withoutBest.includes("accuracy")) {
    keys.add("accuracy");
    keys.add("oof_accuracy");
    keys.add("cv_accuracy");
  }
  if (withoutBest.includes("score")) {
    keys.add("score");
    keys.add("cv_score");
  }

  return unique(Array.from(keys));
}

function isRecognizedBestMetricDimension(dimensionName: string): boolean {
  return dimensionName.startsWith("best_") && deriveMetricKeys(dimensionName).length > 2;
}

function prefersLowerMetric(dimensionName: string): boolean {
  return /loss|error|rmse|mae|mse/i.test(dimensionName);
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIsoMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
