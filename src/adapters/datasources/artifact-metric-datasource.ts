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

interface MetricObservation {
  path: string;
  metrics: Map<string, number>;
}

const BUILTIN_SOURCE_ID = "ds_builtin_workspace_artifacts";
const DEFAULT_METRIC_FILE_NAMES = ["metrics.json", "result.json"];
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

export class ArtifactMetricDataSourceAdapter implements IDataSourceAdapter {
  readonly sourceId: string;
  readonly sourceType: DataSourceType = "artifact_metric";
  readonly config: DataSourceConfig;

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

    if (aggregation === "file_count") {
      const count = await countArtifactFiles(root, this.scanOptions());
      return {
        value: count,
        raw: { root, aggregation, file_count: count },
        timestamp,
        source_id: this.sourceId,
      };
    }

    const metricFiles = await findMetricFiles(root, this.scanOptions());
    const observations = await readMetricObservations(metricFiles);

    if (aggregation === "count") {
      const keys = resolveMetricKeys(params.dimension_name, expression, this.config);
      const count = observations.filter((observation) => hasAnyMetric(observation, keys)).length;
      return {
        value: count,
        raw: {
          root,
          aggregation,
          inspected_metric_files: metricFiles.length,
          matched_metric_files: count,
          metric_keys: keys,
        },
        timestamp,
        source_id: this.sourceId,
      };
    }

    const keys = resolveMetricKeys(params.dimension_name, expression, this.config);
    const match = selectMetric(observations, keys, aggregation);
    return {
      value: match?.value ?? 0,
      raw: {
        root,
        aggregation,
        inspected_metric_files: metricFiles.length,
        metric_keys: keys,
        selected_path: match?.path ?? null,
        selected_key: match?.key ?? null,
        selected_value: match?.value ?? 0,
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
      excludeDirs: new Set([...(this.config.connection.exclude_dirs ?? []), ...DEFAULT_EXCLUDE_DIRS]),
      excludePaths: new Set([
        ...Array.from(DEFAULT_EXCLUDE_PATHS),
        ...(this.config.connection.exclude_paths ?? []),
      ].map(normalizeRelativePath)),
      maxMetricFiles: this.config.connection.max_metric_files ?? DEFAULT_MAX_METRIC_FILES,
      maxArtifactFiles: this.config.connection.max_artifact_files ?? DEFAULT_MAX_ARTIFACT_FILES,
    };
  }
}

interface ScanOptions {
  metricFileNames: Set<string>;
  excludeDirs: Set<string>;
  excludePaths: Set<string>;
  maxMetricFiles: number;
  maxArtifactFiles: number;
}

async function findMetricFiles(root: string, options: ScanOptions): Promise<string[]> {
  const files: string[] = [];
  await walkFiles(root, options, async (filePath) => {
    if (options.metricFileNames.has(path.basename(filePath)) && files.length < options.maxMetricFiles) {
      files.push(filePath);
    }
  });
  return files;
}

async function countArtifactFiles(root: string, options: ScanOptions): Promise<number> {
  let count = 0;
  await walkFiles(root, options, async () => {
    if (count < options.maxArtifactFiles) count += 1;
  });
  return count;
}

async function walkFiles(root: string, options: ScanOptions, onFile: (filePath: string) => Promise<void>): Promise<void> {
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

  await visit(root);
}

function shouldSkipDirectory(name: string, relPath: string, options: ScanOptions): boolean {
  if (options.excludeDirs.has(name)) return true;
  for (const excludedPath of options.excludePaths) {
    if (relPath === excludedPath || relPath.startsWith(`${excludedPath}/`)) return true;
  }
  return false;
}

async function readMetricObservations(files: string[]): Promise<MetricObservation[]> {
  const observations: MetricObservation[] = [];
  for (const filePath of files) {
    try {
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
      const metrics = extractNumericMetrics(parsed);
      if (metrics.size > 0) {
        observations.push({ path: filePath, metrics });
      }
    } catch {
      // Ignore incomplete or invalid artifacts while the long-running process is writing.
    }
  }
  return observations;
}

function extractNumericMetrics(value: unknown): Map<string, number> {
  const metrics = new Map<string, number>();
  if (!isRecord(value)) return metrics;

  for (const [key, field] of Object.entries(value)) {
    addNumber(metrics, key, field);
  }

  const nestedMetrics = value["metrics"];
  if (isRecord(nestedMetrics)) {
    for (const [key, field] of Object.entries(nestedMetrics)) {
      addNumber(metrics, key, field);
    }
  }

  const allMetrics = value["all_metrics"];
  if (isRecord(allMetrics)) {
    for (const [key, field] of Object.entries(allMetrics)) {
      addNumber(metrics, key, field);
    }
  }

  const metricName = typeof value["metric_name"] === "string" ? value["metric_name"] : null;
  if (metricName) {
    addNumber(metrics, metricName, value["score"]);
    addNumber(metrics, metricName, value["cv_score"]);
  }

  const evidence = value["evidence"];
  if (Array.isArray(evidence)) {
    for (const item of evidence) {
      if (!isRecord(item)) continue;
      const label = typeof item["label"] === "string" ? item["label"] : null;
      if (!label) continue;
      addNumber(metrics, label, item["value"]);
    }
  }

  return metrics;
}

function addNumber(metrics: Map<string, number>, key: string, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    metrics.set(key, value);
  }
}

function hasAnyMetric(observation: MetricObservation, keys: string[]): boolean {
  if (keys.length === 0) return observation.metrics.size > 0;
  return keys.some((key) => observation.metrics.has(key));
}

function selectMetric(
  observations: MetricObservation[],
  keys: string[],
  aggregation: "max" | "min",
): { path: string; key: string; value: number } | null {
  let selected: { path: string; key: string; value: number } | null = null;
  for (const observation of observations) {
    for (const key of keys) {
      const value = observation.metrics.get(key);
      if (value === undefined) continue;
      if (
        selected === null ||
        (aggregation === "max" && value > selected.value) ||
        (aggregation === "min" && value < selected.value)
      ) {
        selected = { path: observation.path, key, value };
      }
    }
  }
  return selected;
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

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
