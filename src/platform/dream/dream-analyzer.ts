import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import { writeJsonFileAtomic } from "../../base/utils/json-io.js";
import type { Logger } from "../../runtime/logger.js";
import type { LearningPipeline } from "../knowledge/learning/learning-pipeline.js";
import type { LearnedPattern, LearnedPatternType } from "../knowledge/types/learning.js";
import {
  buildDreamPatternAnalysisPrompt,
  DREAM_PATTERN_ANALYSIS_SYSTEM_PROMPT,
} from "../../prompt/purposes/dream.js";
import {
  DreamPatternResponseSchema,
  ImportanceEntrySchema,
  IterationLogSchema,
  ScheduleSuggestionFileSchema,
  SessionLogSchema,
  type DreamLogConfig,
  type DreamPatternCandidate,
  type DreamPhase,
  type DreamRunReport,
  type DreamTier,
  type ImportanceEntry,
  type IngestionOutput,
  type IterationLog,
  type IterationWindow,
  type ScheduleSuggestion,
  type SessionLog,
} from "./dream-types.js";
import { DEFAULT_DREAM_CONFIG } from "./dream-config.js";
import { DreamLogCollector } from "./dream-log-collector.js";

export interface DreamRunOptions {
  goalIds?: string[];
  phases?: DreamPhase[];
  tier?: DreamTier;
  dryRun?: boolean;
  tokenBudget?: number;
  recentIterationWindow?: number;
}

interface DreamAnalyzerDeps {
  baseDir: string;
  llmClient?: ILLMClient;
  learningPipeline?: LearningPipeline;
  logger?: Logger;
  config?: Partial<DreamLogConfig["analysis"]>;
}

export class DreamAnalyzer {
  private readonly collector: DreamLogCollector;
  private readonly logger?: Logger;
  private readonly llmClient?: ILLMClient;
  private readonly learningPipeline?: LearningPipeline;
  private readonly config: DreamLogConfig["analysis"];

  constructor(private readonly deps: DreamAnalyzerDeps) {
    this.collector = new DreamLogCollector(deps.baseDir, deps.logger);
    this.logger = deps.logger;
    this.llmClient = deps.llmClient;
    this.learningPipeline = deps.learningPipeline;
    this.config = {
      ...DEFAULT_DREAM_CONFIG.analysis,
      ...deps.config,
    };
  }

  async run(options: DreamRunOptions = {}): Promise<DreamRunReport> {
    const tier = options.tier ?? "deep";
    return tier === "light" ? this.runLight(options) : this.runDeep(options);
  }

  async runLight(options: DreamRunOptions = {}): Promise<DreamRunReport> {
    return this.execute({
      ...options,
      tier: "light",
      phases: options.phases ?? ["A", "B"],
      tokenBudget: options.tokenBudget ?? this.config.lightTokenBudget,
      recentIterationWindow: options.recentIterationWindow ?? this.config.lightRecentIterationWindow,
    });
  }

  async runDeep(options: DreamRunOptions = {}): Promise<DreamRunReport> {
    return this.execute({
      ...options,
      tier: "deep",
      phases: options.phases ?? ["A", "B", "C"],
      tokenBudget: options.tokenBudget ?? this.config.deepTokenBudget,
    });
  }

  private async execute(options: Required<Pick<DreamRunOptions, "tier" | "tokenBudget">> & DreamRunOptions): Promise<DreamRunReport> {
    const phases = options.phases ?? (options.tier === "light" ? ["A", "B"] : ["A", "B", "C"]);
    const goalIds = await this.resolveGoalIds(options.goalIds);
    const selectedGoalIds = goalIds.slice(0, this.config.maxGoalsPerRun);
    const ingestion = await this.ingest(selectedGoalIds, options);

    let remainingBudget = options.tokenBudget;
    let partial = false;
    let patterns: LearnedPattern[] = [];
    let suggestions: ScheduleSuggestion[] = [];
    const completedPhases: DreamPhase[] = [];

    if (phases.includes("A")) {
      completedPhases.push("A");
    }

    if (phases.includes("B")) {
      const analysis = await this.analyze(ingestion, selectedGoalIds, options.tier, remainingBudget);
      patterns = analysis.patterns;
      remainingBudget = analysis.remainingBudget;
      partial = analysis.partial;
      if (!options.dryRun) {
        await this.persistPatterns(patterns);
        await this.advanceWatermarks(ingestion);
      }
      completedPhases.push("B");
    }

    if (!partial && phases.includes("C") && options.tier === "deep") {
      suggestions = this.buildScheduleSuggestions(ingestion.sessionLogs);
      if (!options.dryRun) {
        await this.persistScheduleSuggestions(suggestions);
      }
      completedPhases.push("C");
    }

    return {
      tier: options.tier,
      phasesCompleted: completedPhases,
      goalsProcessed: selectedGoalIds,
      patternsPersisted: patterns.length,
      scheduleSuggestions: suggestions.length,
      tokensEstimated: options.tokenBudget - remainingBudget,
      partial,
      stats: ingestion.stats,
      learnedPatterns: patterns,
      suggestions,
    };
  }

  private async resolveGoalIds(requested?: string[]): Promise<string[]> {
    if (requested && requested.length > 0) {
      return Array.from(new Set(requested));
    }
    const goalsDir = path.join(this.deps.baseDir, "goals");
    const entries = await fsp.readdir(goalsDir, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  private async ingest(goalIds: string[], options: DreamRunOptions): Promise<IngestionOutput> {
    const watermarks = await this.collector.loadWatermarks();
    const importanceEntries = await this.readImportanceEntries(watermarks.importanceBuffer.lastProcessedLine);
    const sessionLogs = await this.readSessionLogs();
    const goalIterations = new Map<string, IterationLog[]>();
    let malformedLines = 0;
    let linesRead = 0;

    for (const goalId of goalIds) {
      const goalWatermark = watermarks.goals[goalId]?.lastProcessedLine ?? 0;
      const { entries, malformedCount, lineCount } = await this.readIterationLogs(goalId, goalWatermark);
      goalIterations.set(goalId, entries);
      malformedLines += malformedCount;
      linesRead += lineCount;
    }

    const prioritizedBatches = this.buildImportanceWindows(goalIterations, importanceEntries);
    const regularBatches = this.buildRegularWindows(goalIterations, options);

    return {
      prioritizedBatches,
      regularBatches,
      importanceEntries,
      sessionLogs,
      stats: {
        linesRead,
        malformedLines,
        batchesBuilt: prioritizedBatches.length + regularBatches.length,
      },
    };
  }

  private async readIterationLogs(goalId: string, startLine: number): Promise<{ entries: IterationLog[]; malformedCount: number; lineCount: number }> {
    const filePath = path.join(this.deps.baseDir, "goals", goalId, "iteration-logs.jsonl");
    const raw = await fsp.readFile(filePath, "utf8").catch(() => "");
    const lines = raw.split(/\r?\n/);
    let malformedCount = 0;
    const entries: IterationLog[] = [];
    for (let index = startLine; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line || line.trim().length === 0) continue;
      try {
        entries.push(IterationLogSchema.parse(JSON.parse(line)));
      } catch (error) {
        malformedCount += 1;
        this.logger?.warn("Dream ingestion skipped malformed iteration line", {
          goalId,
          line: index + 1,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { entries, malformedCount, lineCount: Math.max(lines.length - 1, 0) };
  }

  private async readImportanceEntries(startLine: number): Promise<ImportanceEntry[]> {
    const filePath = path.join(this.deps.baseDir, "dream", "importance-buffer.jsonl");
    const raw = await fsp.readFile(filePath, "utf8").catch(() => "");
    return raw
      .split(/\r?\n/)
      .slice(startLine)
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [ImportanceEntrySchema.parse(JSON.parse(line))];
        } catch (error) {
          this.logger?.warn("Dream ingestion skipped malformed importance line", {
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      });
  }

  private async readSessionLogs(): Promise<SessionLog[]> {
    const filePath = path.join(this.deps.baseDir, "dream", "session-logs.jsonl");
    const raw = await fsp.readFile(filePath, "utf8").catch(() => "");
    return raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [SessionLogSchema.parse(JSON.parse(line))];
        } catch {
          return [];
        }
      });
  }

  private buildImportanceWindows(goalIterations: Map<string, IterationLog[]>, importanceEntries: ImportanceEntry[]): IterationWindow[] {
    return importanceEntries.flatMap((entry) => {
      const iterations = goalIterations.get(entry.goalId) ?? [];
      if (iterations.length === 0) return [];
      const iterationNumber = this.extractIterationRef(entry.data_ref);
      const matchIndex = iterations.findIndex((item) => item.iteration === iterationNumber);
      if (matchIndex < 0) return [];
      const window = iterations.slice(Math.max(0, matchIndex - 2), Math.min(iterations.length, matchIndex + 3));
      return [{
        goalId: entry.goalId,
        startIteration: window[0]?.iteration ?? iterationNumber ?? 0,
        endIteration: window[window.length - 1]?.iteration ?? iterationNumber ?? 0,
        iterations: window,
        evidenceRefs: [entry.data_ref],
        importance: entry.importance,
        source: "importance",
      }];
    });
  }

  private buildRegularWindows(goalIterations: Map<string, IterationLog[]>, options: DreamRunOptions): IterationWindow[] {
    const windows: IterationWindow[] = [];
    for (const [goalId, iterations] of goalIterations.entries()) {
      const scopedIterations =
        options.tier === "light"
          ? iterations.slice(-1 * (options.recentIterationWindow ?? this.config.lightRecentIterationWindow))
          : iterations;
      for (let index = 0; index < scopedIterations.length; index += this.config.batchSize) {
        const chunk = scopedIterations.slice(index, index + this.config.batchSize);
        if (chunk.length === 0) continue;
        windows.push({
          goalId,
          startIteration: chunk[0].iteration,
          endIteration: chunk[chunk.length - 1].iteration,
          iterations: chunk,
          evidenceRefs: chunk.map((entry) => `iter:${goalId}:${entry.iteration}`),
          source: options.tier === "light" ? "recent" : "regular",
        });
      }
    }
    return windows;
  }

  private async analyze(
    ingestion: IngestionOutput,
    goalIds: string[],
    tier: DreamTier,
    budget: number
  ): Promise<{ patterns: LearnedPattern[]; remainingBudget: number; partial: boolean }> {
    const allWindows = [...ingestion.prioritizedBatches, ...ingestion.regularBatches];
    const enoughData = allWindows.reduce((sum, window) => sum + window.iterations.length, 0) >= this.config.minIterationsForAnalysis;
    if (!this.llmClient || !this.learningPipeline || !enoughData) {
      return { patterns: [], remainingBudget: budget, partial: false };
    }

    const learnedPatterns: LearnedPattern[] = [];
    let remainingBudget = budget;
    let partial = false;

    for (const goalId of goalIds) {
      const prioritized = ingestion.prioritizedBatches.filter((window) => window.goalId === goalId);
      const regular = ingestion.regularBatches.filter((window) => window.goalId === goalId);
      if (prioritized.length === 0 && regular.length === 0) continue;

      const prompt = buildDreamPatternAnalysisPrompt({
        tier,
        goalId,
        prioritizedWindows: JSON.stringify(prioritized.slice(0, 5), null, 2),
        regularWindows: JSON.stringify(regular.slice(0, tier === "light" ? 3 : 10), null, 2),
        importanceEntries: JSON.stringify(
          ingestion.importanceEntries.filter((entry) => entry.goalId === goalId).slice(0, 10),
          null,
          2
        ),
      });
      const estimatedCost = this.estimateTokens(prompt);
      if (remainingBudget - estimatedCost < 0) {
        partial = true;
        break;
      }

      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: prompt }],
        {
          system: DREAM_PATTERN_ANALYSIS_SYSTEM_PROMPT,
          max_tokens: tier === "light" ? 1200 : 2400,
          temperature: 0,
        }
      );
      remainingBudget -= estimatedCost + response.usage.output_tokens;
      const parsed = this.llmClient.parseJSON(response.content, DreamPatternResponseSchema);
      const mapped = (parsed.patterns ?? [])
        .filter((pattern) => pattern.confidence >= this.config.patternConfidenceThreshold)
        .map((pattern) =>
          this.toLearnedPattern(goalId, {
            ...pattern,
            metadata: pattern.metadata ?? {},
            evidence_refs: pattern.evidence_refs ?? [],
          })
        );
      learnedPatterns.push(...mapped);
    }

    return { patterns: learnedPatterns, remainingBudget, partial };
  }

  private toLearnedPattern(goalId: string, candidate: DreamPatternCandidate): LearnedPattern {
    const type = this.mapPatternType(candidate.pattern_type);
    return {
      pattern_id: `dream_${randomUUID()}`,
      type,
      description: candidate.summary,
      confidence: candidate.confidence,
      evidence_count: candidate.evidence_refs.length,
      source_goal_ids: [candidate.goal_id ?? goalId],
      applicable_domains: this.extractApplicableDomains(candidate),
      embedding_id: null,
      created_at: new Date().toISOString(),
      last_applied_at: null,
    };
  }

  private mapPatternType(patternType: string): LearnedPatternType {
    if (patternType.includes("observation")) return "observation_accuracy";
    if (patternType.includes("strategy") || patternType.includes("stall") || patternType.includes("decision")) {
      return "strategy_selection";
    }
    if (patternType.includes("verification") || patternType.includes("task")) {
      return "task_generation";
    }
    return "scope_sizing";
  }

  private extractApplicableDomains(candidate: DreamPatternCandidate): string[] {
    const value = candidate.metadata.applicable_domains;
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string");
    }
    if (typeof candidate.metadata.taskAction === "string") {
      return [candidate.metadata.taskAction];
    }
    return [];
  }

  private async persistPatterns(patterns: LearnedPattern[]): Promise<void> {
    if (!this.learningPipeline || patterns.length === 0) return;
    const byGoal = new Map<string, LearnedPattern[]>();
    for (const pattern of patterns) {
      for (const goalId of pattern.source_goal_ids) {
        const list = byGoal.get(goalId) ?? [];
        list.push(pattern);
        byGoal.set(goalId, list);
      }
    }

    for (const [goalId, newPatterns] of byGoal.entries()) {
      const existing = await this.learningPipeline.getPatterns(goalId);
      await this.learningPipeline.savePatterns(goalId, [...existing, ...newPatterns]);
    }
  }

  private async advanceWatermarks(ingestion: IngestionOutput): Promise<void> {
    const grouped = new Map<string, number>();
    for (const batch of [...ingestion.prioritizedBatches, ...ingestion.regularBatches]) {
      grouped.set(batch.goalId, Math.max(grouped.get(batch.goalId) ?? 0, batch.endIteration + 1));
    }
    for (const [goalId, lastProcessedLine] of grouped.entries()) {
      await this.collector.markGoalProcessed(goalId, lastProcessedLine);
    }
    await this.collector.markImportanceProcessed(ingestion.importanceEntries.length);
  }

  private buildScheduleSuggestions(sessionLogs: SessionLog[]): ScheduleSuggestion[] {
    const byGoalHour = new Map<string, Map<number, number>>();
    for (const session of sessionLogs) {
      const hour = new Date(session.timestamp).getUTCHours();
      const hourMap = byGoalHour.get(session.goalId) ?? new Map<number, number>();
      hourMap.set(hour, (hourMap.get(hour) ?? 0) + 1);
      byGoalHour.set(session.goalId, hourMap);
    }

    const suggestions: ScheduleSuggestion[] = [];
    for (const [goalId, hourMap] of byGoalHour.entries()) {
      const best = [...hourMap.entries()].sort((left, right) => right[1] - left[1])[0];
      if (!best || best[1] < 3) continue;
      const [hour, count] = best;
      suggestions.push({
        type: "cron",
        goalId,
        confidence: Math.min(0.95, 0.55 + count * 0.08),
        reason: `Manual execution clusters around ${hour.toString().padStart(2, "0")}:00 UTC.`,
        proposal: `0 ${hour} * * *`,
      });
    }
    return suggestions;
  }

  private async persistScheduleSuggestions(suggestions: ScheduleSuggestion[]): Promise<void> {
    const filePath = path.join(this.deps.baseDir, "dream", "schedule-suggestions.json");
    const payload = ScheduleSuggestionFileSchema.parse({
      generated_at: new Date().toISOString(),
      suggestions,
    });
    await writeJsonFileAtomic(filePath, payload);
  }

  private estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  }

  private extractIterationRef(dataRef: string): number | null {
    const match = /:(\d+)$/.exec(dataRef) ?? /#L(\d+)$/.exec(dataRef);
    return match ? Number.parseInt(match[1], 10) : null;
  }
}
