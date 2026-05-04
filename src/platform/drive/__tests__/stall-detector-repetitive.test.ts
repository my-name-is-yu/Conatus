import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../../../base/state/state-manager.js";
import { StallDetector } from "../stall-detector.js";
import type { StallTaskHistoryEntry } from "../stall-detector.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

let tempDir: string;
let stateManager: StateManager;
let detector: StallDetector;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  detector = new StallDetector(stateManager);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
});

describe("detectRepetitivePatterns", () => {
  it("returns not repetitive when history is too short", () => {
    const history: StallTaskHistoryEntry[] = [
      { strategy_id: "s1", output: "did something" },
      { strategy_id: "s1", output: "did something" },
    ];
    const result = detector.detectRepetitivePatterns(history);
    expect(result.isRepetitive).toBe(false);
    expect(result.pattern).toBeNull();
    expect(result.source).toBe("none");
  });

  it("detects identical_actions as a text fallback when same strategy and similar output repeated 3+ times", () => {
    const output = "Ran the test suite and updated 3 files with the same approach each time.";
    const history: StallTaskHistoryEntry[] = [
      { strategy_id: "strategy-abc", output },
      { strategy_id: "strategy-abc", output },
      { strategy_id: "strategy-abc", output },
    ];
    const result = detector.detectRepetitivePatterns(history);
    expect(result.isRepetitive).toBe(true);
    expect(result.pattern).toBe("identical_actions");
    expect(result.confidence).toBeLessThanOrEqual(0.6);
    expect(result.source).toBe("text_fallback");
  });

  it("detects oscillating pattern as a text fallback when outputs alternate A→B→A→B", () => {
    const history: StallTaskHistoryEntry[] = [
      { strategy_id: "s1", output: "output-alpha" },
      { strategy_id: "s2", output: "output-beta" },
      { strategy_id: "s1", output: "output-alpha" },
      { strategy_id: "s2", output: "output-beta" },
    ];
    const result = detector.detectRepetitivePatterns(history);
    expect(result.isRepetitive).toBe(true);
    expect(result.pattern).toBe("oscillating");
    expect(result.confidence).toBeLessThanOrEqual(0.6);
    expect(result.source).toBe("text_fallback");
  });

  it("detects no_change as a low-confidence fallback when outputs repeatedly say no changes made", () => {
    const history: StallTaskHistoryEntry[] = [
      { strategy_id: "s1", output: "Checked files. No changes made." },
      { strategy_id: "s1", output: "Reviewed code. No changes made to the codebase." },
      { strategy_id: "s2", output: "Inspected state. No changes made at this time." },
    ];
    const result = detector.detectRepetitivePatterns(history);
    expect(result.isRepetitive).toBe(true);
    expect(result.pattern).toBe("no_change");
    expect(result.confidence).toBeLessThanOrEqual(0.6);
    expect(result.source).toBe("text_fallback");
  });

  it("uses typed no-op task result evidence to detect repeated no-change work", () => {
    const history: StallTaskHistoryEntry[] = [
      {
        strategy_id: "s1",
        output: "Checked repository state.",
        task_result: {
          changed_files: [],
          diff_stats: { files_changed: 0, insertions: 0, deletions: 0 },
          tool_calls: [{ tool_name: "ReadPulseedFileTool", status: "success" }],
          verification_status: "passed",
          artifact_changes: [],
        },
      },
      {
        strategy_id: "s1",
        output: "Inspected implementation status.",
        task_result: {
          changed_files: [],
          diff_stats: { files_changed: 0, insertions: 0, deletions: 0 },
          tool_calls: [{ tool_name: "GitDiffTool", status: "success" }],
          verification_status: "passed",
          artifact_changes: [],
        },
      },
      {
        strategy_id: "s2",
        output: "Verified there is still no persisted work.",
        task_result: {
          changed_files: [],
          diff_stats: { files_changed: 0, insertions: 0, deletions: 0 },
          tool_calls: [{ tool_name: "TestRunnerTool", status: "success" }],
          verification_status: "passed",
          artifact_changes: [],
        },
      },
    ];

    const result = detector.detectRepetitivePatterns(history);

    expect(result).toMatchObject({
      isRepetitive: true,
      pattern: "no_change",
      source: "typed_task_result",
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("does not treat boilerplate-similar output as repeated action when typed evidence has real file changes", () => {
    const output = "Ran command. Exit code 0.";
    const history: StallTaskHistoryEntry[] = [
      {
        strategy_id: "s1",
        output,
        task_result: {
          changed_files: ["src/a.ts"],
          diff_stats: { files_changed: 1, insertions: 8, deletions: 0 },
          tool_calls: [{ tool_name: "WritePulseedFileTool", status: "success" }],
          verification_status: "not_run",
          artifact_changes: [],
        },
      },
      {
        strategy_id: "s1",
        output,
        task_result: {
          changed_files: ["src/b.ts"],
          diff_stats: { files_changed: 1, insertions: 0, deletions: 3 },
          tool_calls: [{ tool_name: "WritePulseedFileTool", status: "success" }],
          verification_status: "not_run",
          artifact_changes: [],
        },
      },
      {
        strategy_id: "s1",
        output,
        task_result: {
          changed_files: ["docs/result.md"],
          diff_stats: { files_changed: 1, insertions: 2, deletions: 1 },
          tool_calls: [{ tool_name: "WritePulseedFileTool", status: "success" }],
          verification_status: "passed",
          artifact_changes: [{ artifact_id: "docs/result.md", change_type: "updated" }],
        },
      },
    ];

    const result = detector.detectRepetitivePatterns(history);

    expect(result).toMatchObject({
      isRepetitive: false,
      pattern: null,
      source: "typed_task_result",
    });
  });

  it("lets a single typed material-change entry suppress text fallback in a mixed history window", () => {
    const output = "Ran command. Exit code 0.";
    const history: StallTaskHistoryEntry[] = [
      { strategy_id: "s1", output },
      {
        strategy_id: "s1",
        output,
        task_result: {
          changed_files: ["src/progress.ts"],
          diff_stats: { files_changed: 1, insertions: 4, deletions: 0 },
        },
      },
      { strategy_id: "s1", output },
    ];

    const result = detector.detectRepetitivePatterns(history);

    expect(result).toMatchObject({
      isRepetitive: false,
      pattern: null,
      source: "typed_task_result",
    });
  });

  it("does not classify tool-call-only task results as typed no-op evidence", () => {
    const history: StallTaskHistoryEntry[] = [
      {
        strategy_id: "s1",
        output: "Inspected runtime state.",
        task_result: {
          tool_calls: [{ tool_name: "ReadPulseedFileTool", status: "success" }],
          verification_status: "not_run",
        },
      },
      {
        strategy_id: "s2",
        output: "Checked queue state.",
        task_result: {
          tool_calls: [{ tool_name: "GitDiffTool", status: "success" }],
          verification_status: "not_run",
        },
      },
      {
        strategy_id: "s3",
        output: "Read logs.",
        task_result: {
          tool_calls: [{ tool_name: "ProcessStatusTool", status: "success" }],
          verification_status: "not_run",
        },
      },
    ];

    const result = detector.detectRepetitivePatterns(history);

    expect(result).toMatchObject({
      isRepetitive: false,
      pattern: null,
      source: "none",
    });
  });

  it("returns not repetitive for genuinely different outputs", () => {
    const history: StallTaskHistoryEntry[] = [
      { strategy_id: "s1", output: "Updated authentication module with OAuth2 support" },
      { strategy_id: "s2", output: "Refactored database layer to use connection pooling" },
      { strategy_id: "s3", output: "Added rate limiting middleware to API endpoints" },
    ];
    const result = detector.detectRepetitivePatterns(history);
    expect(result.isRepetitive).toBe(false);
    expect(result.pattern).toBeNull();
    expect(result.source).toBe("none");
  });

  it("does not flag identical_actions when strategy_id is null", () => {
    const output = "Ran command. Exit code 0.";
    const history: StallTaskHistoryEntry[] = [
      { strategy_id: null, output },
      { strategy_id: null, output },
      { strategy_id: null, output },
    ];
    const result = detector.detectRepetitivePatterns(history);
    // null strategy_id should not trigger identical_actions
    expect(result.pattern).not.toBe("identical_actions");
  });
});
