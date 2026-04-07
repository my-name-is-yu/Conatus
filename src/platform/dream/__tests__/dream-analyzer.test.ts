import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { DreamAnalyzer } from "../dream-analyzer.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../../base/llm/llm-client.js";
import type { LearnedPattern } from "../../knowledge/types/learning.js";

class MockLLMClient implements ILLMClient {
  constructor(private readonly content: string) {}

  async sendMessage(_messages: LLMMessage[], _options?: LLMRequestOptions): Promise<LLMResponse> {
    return {
      content: this.content,
      usage: { input_tokens: 400, output_tokens: 120 },
      stop_reason: "stop",
    };
  }

  parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
    return schema.parse(JSON.parse(content));
  }
}

describe("DreamAnalyzer", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
    tmpDir = "";
  });

  it("runs light analysis and persists learned patterns through the learning pipeline", async () => {
    tmpDir = makeTempDir("dream-analyzer-light-");
    await seedDreamLogs(tmpDir, "goal-1", 24);
    const saved = new Map<string, LearnedPattern[]>();
    const learningPipeline = {
      getPatterns: vi.fn(async (goalId: string) => saved.get(goalId) ?? []),
      savePatterns: vi.fn(async (goalId: string, patterns: LearnedPattern[]) => {
        saved.set(goalId, patterns);
      }),
    };
    const analyzer = new DreamAnalyzer({
      baseDir: tmpDir,
      llmClient: new MockLLMClient(JSON.stringify({
        patterns: [
          {
            pattern_type: "recurring_task",
            confidence: 0.88,
            summary: "Retry verification after medium-confidence observation drift.",
            evidence_refs: ["iter:goal-1:21", "iter:goal-1:22"],
            metadata: { taskAction: "rerun_verification" },
          },
        ],
      })),
      learningPipeline: learningPipeline as never,
    });

    const report = await analyzer.runLight({ goalIds: ["goal-1"] });

    expect(report.tier).toBe("light");
    expect(report.phasesCompleted).toEqual(["A", "B"]);
    expect(report.patternsPersisted).toBe(1);
    expect(learningPipeline.savePatterns).toHaveBeenCalledTimes(1);
    expect(saved.get("goal-1")).toHaveLength(1);
  });

  it("runs deep analysis, writes schedule suggestions, and advances watermarks", async () => {
    tmpDir = makeTempDir("dream-analyzer-deep-");
    await seedDreamLogs(tmpDir, "goal-2", 30, {
      sessionHours: [9, 9, 9, 11],
      importanceLine: true,
    });
    const learningPipeline = {
      getPatterns: vi.fn(async () => []),
      savePatterns: vi.fn(async () => undefined),
    };
    const analyzer = new DreamAnalyzer({
      baseDir: tmpDir,
      llmClient: new MockLLMClient(JSON.stringify({
        patterns: [
          {
            pattern_type: "strategy_effectiveness",
            confidence: 0.82,
            summary: "Pivoting after repeated stalls improves convergence.",
            evidence_refs: ["iter:goal-2:10", "iter:goal-2:11"],
            metadata: { applicable_domains: ["strategy"] },
          },
        ],
      })),
      learningPipeline: learningPipeline as never,
    });

    const report = await analyzer.runDeep({ goalIds: ["goal-2"] });
    const suggestions = JSON.parse(
      await fs.readFile(path.join(tmpDir, "dream", "schedule-suggestions.json"), "utf8")
    ) as { suggestions: Array<{ goalId?: string; proposal: string }> };
    const watermarks = JSON.parse(
      await fs.readFile(path.join(tmpDir, "dream", "watermarks.json"), "utf8")
    ) as { goals: Record<string, { lastProcessedLine: number }> };

    expect(report.phasesCompleted).toEqual(["A", "B", "C"]);
    expect(report.scheduleSuggestions).toBe(1);
    expect(suggestions.suggestions[0]).toMatchObject({
      goalId: "goal-2",
      proposal: "0 9 * * *",
    });
    expect(watermarks.goals["goal-2"]?.lastProcessedLine).toBeGreaterThan(0);
  });
});

async function seedDreamLogs(
  baseDir: string,
  goalId: string,
  count: number,
  options: { sessionHours?: number[]; importanceLine?: boolean } = {}
): Promise<void> {
  const goalDir = path.join(baseDir, "goals", goalId);
  const dreamDir = path.join(baseDir, "dream");
  await fs.mkdir(goalDir, { recursive: true });
  await fs.mkdir(dreamDir, { recursive: true });

  const iterationLines = Array.from({ length: count }, (_, index) =>
    JSON.stringify({
      timestamp: new Date(Date.UTC(2026, 3, 7, 0, index, 0)).toISOString(),
      goalId,
      iteration: index,
      sessionId: `${goalId}:session-1`,
      gapAggregate: Math.max(0, 1 - index * 0.02),
      driveScores: [{ dimensionName: "progress", score: 0.4 + index * 0.01 }],
      taskId: `task-${index}`,
      taskAction: "rerun_verification",
      strategyId: "strategy-a",
      verificationResult: {
        verdict: index % 2 === 0 ? "pass" : "warn",
        confidence: 0.7,
        timestamp: new Date(Date.UTC(2026, 3, 7, 0, index, 0)).toISOString(),
      },
      stallDetected: index % 7 === 0,
      stallSeverity: index % 7 === 0 ? 2 : null,
      tokensUsed: 50,
      elapsedMs: 1000,
      skipped: false,
      skipReason: null,
      completionJudgment: {},
      waitSuppressed: false,
    })
  ).join("\n");
  await fs.writeFile(path.join(goalDir, "iteration-logs.jsonl"), `${iterationLines}\n`, "utf8");

  const hours = options.sessionHours ?? [8, 9, 10];
  const sessionLines = hours.map((hour, index) =>
    JSON.stringify({
      timestamp: new Date(Date.UTC(2026, 3, 7 + index, hour, 0, 0)).toISOString(),
      goalId,
      sessionId: `${goalId}:session-${index + 1}`,
      iterationCount: 10,
      finalGapAggregate: 0.2,
      initialGapAggregate: 0.9,
      totalTokensUsed: 500,
      totalElapsedMs: 10_000,
      stallCount: 1,
      outcome: "completed",
      strategiesUsed: ["strategy-a"],
    })
  ).join("\n");
  await fs.writeFile(path.join(dreamDir, "session-logs.jsonl"), `${sessionLines}\n`, "utf8");

  if (options.importanceLine) {
    await fs.writeFile(
      path.join(dreamDir, "importance-buffer.jsonl"),
      `${JSON.stringify({
        id: "imp-1",
        timestamp: new Date(Date.UTC(2026, 3, 7, 0, 5, 0)).toISOString(),
        goalId,
        source: "verification",
        importance: 0.9,
        reason: "Repeated warning",
        data_ref: `iter:${goalId}:5`,
        tags: ["warning"],
        processed: false,
      })}\n`,
      "utf8"
    );
  }
}
