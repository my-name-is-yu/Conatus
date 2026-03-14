import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";
import { StateManager } from "../src/state-manager.js";
import { EthicsGate } from "../src/ethics-gate.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../src/llm-client.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";

// ─── Fixtures ───

const PASS_VERDICT_JSON = JSON.stringify({
  verdict: "pass",
  category: "safe",
  reasoning: "This goal is clearly safe and ethical.",
  risks: [],
  confidence: 0.95,
});

const REJECT_VERDICT_JSON = JSON.stringify({
  verdict: "reject",
  category: "illegal",
  reasoning: "This goal involves clearly illegal activities.",
  risks: ["illegal activity", "potential harm to others"],
  confidence: 0.99,
});

const FLAG_VERDICT_JSON = JSON.stringify({
  verdict: "flag",
  category: "privacy_concern",
  reasoning: "This goal involves collecting user data, which may raise privacy concerns.",
  risks: ["potential privacy violation", "data misuse"],
  confidence: 0.70,
});

const LOW_CONFIDENCE_PASS_JSON = JSON.stringify({
  verdict: "pass",
  category: "ambiguous",
  reasoning: "The goal seems OK but the description is too vague to be sure.",
  risks: ["ambiguous scope"],
  confidence: 0.30,
});

const HIGH_CONFIDENCE_FLAG_JSON = JSON.stringify({
  verdict: "flag",
  category: "ambiguous",
  reasoning: "There are some concerns that need review.",
  risks: ["unclear intent"],
  confidence: 0.75,
});

// Malformed JSON to test parse failure
const MALFORMED_JSON = "This is not JSON at all.";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-ethics-test-"));
}

describe("EthicsGate", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let gate: EthicsGate;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── check() — verdict pass ───

  describe("check() with pass verdict", () => {
    beforeEach(() => {
      gate = new EthicsGate(stateManager, createMockLLMClient([PASS_VERDICT_JSON]));
    });

    it("returns a pass verdict", async () => {
      const verdict = await gate.check("goal", "goal-1", "Improve software quality");
      expect(verdict.verdict).toBe("pass");
    });

    it("returns the correct category from LLM", async () => {
      const verdict = await gate.check("goal", "goal-1", "Improve software quality");
      expect(verdict.category).toBe("safe");
    });

    it("returns the correct confidence from LLM", async () => {
      const verdict = await gate.check("goal", "goal-1", "Improve software quality");
      expect(verdict.confidence).toBe(0.95);
    });

    it("returns an empty risks array", async () => {
      const verdict = await gate.check("goal", "goal-1", "Improve software quality");
      expect(verdict.risks).toEqual([]);
    });
  });

  // ─── check() — verdict reject ───

  describe("check() with reject verdict", () => {
    beforeEach(() => {
      gate = new EthicsGate(stateManager, createMockLLMClient([REJECT_VERDICT_JSON]));
    });

    it("returns a reject verdict", async () => {
      const verdict = await gate.check("goal", "goal-2", "Help me commit fraud");
      expect(verdict.verdict).toBe("reject");
    });

    it("returns the correct category", async () => {
      const verdict = await gate.check("goal", "goal-2", "Help me commit fraud");
      expect(verdict.category).toBe("illegal");
    });

    it("returns the identified risks", async () => {
      const verdict = await gate.check("goal", "goal-2", "Help me commit fraud");
      expect(verdict.risks).toContain("illegal activity");
      expect(verdict.risks).toContain("potential harm to others");
    });
  });

  // ─── check() — verdict flag ───

  describe("check() with flag verdict", () => {
    beforeEach(() => {
      gate = new EthicsGate(stateManager, createMockLLMClient([FLAG_VERDICT_JSON]));
    });

    it("returns a flag verdict", async () => {
      const verdict = await gate.check("goal", "goal-3", "Collect user browsing history");
      expect(verdict.verdict).toBe("flag");
    });

    it("returns the correct category", async () => {
      const verdict = await gate.check("goal", "goal-3", "Collect user browsing history");
      expect(verdict.category).toBe("privacy_concern");
    });

    it("returns the risks list", async () => {
      const verdict = await gate.check("goal", "goal-3", "Collect user browsing history");
      expect(verdict.risks.length).toBeGreaterThan(0);
    });
  });

  // ─── check() — auto-flag when confidence < 0.6 ───

  describe("check() auto-flag on low confidence", () => {
    beforeEach(() => {
      gate = new EthicsGate(stateManager, createMockLLMClient([LOW_CONFIDENCE_PASS_JSON]));
    });

    it("overrides 'pass' to 'flag' when confidence < 0.6", async () => {
      const verdict = await gate.check("goal", "goal-4", "Do something vague");
      expect(verdict.verdict).toBe("flag");
    });

    it("preserves the original category and reasoning", async () => {
      const verdict = await gate.check("goal", "goal-4", "Do something vague");
      expect(verdict.category).toBe("ambiguous");
      expect(verdict.confidence).toBe(0.30);
    });

    it("does NOT override 'reject' when confidence is low", async () => {
      const lowConfidenceReject = JSON.stringify({
        verdict: "reject",
        category: "illegal",
        reasoning: "Clearly illegal even with low confidence",
        risks: ["illegal"],
        confidence: 0.40,
      });
      const g = new EthicsGate(stateManager, createMockLLMClient([lowConfidenceReject]));
      const verdict = await g.check("goal", "goal-x", "Do something illegal");
      // reject should remain reject (low confidence override only applies to 'pass')
      expect(verdict.verdict).toBe("reject");
    });

    it("does NOT override 'flag' when confidence is low (flag stays flag)", async () => {
      const lowConfidenceFlag = JSON.stringify({
        verdict: "flag",
        category: "ambiguous",
        reasoning: "Uncertain",
        risks: [],
        confidence: 0.20,
      });
      const g = new EthicsGate(stateManager, createMockLLMClient([lowConfidenceFlag]));
      const verdict = await g.check("goal", "goal-y", "Something uncertain");
      expect(verdict.verdict).toBe("flag");
    });

    it("does NOT override 'pass' when confidence is exactly 0.6 (boundary)", async () => {
      const boundaryConfidence = JSON.stringify({
        verdict: "pass",
        category: "safe",
        reasoning: "Borderline safe",
        risks: [],
        confidence: 0.6,
      });
      const g = new EthicsGate(stateManager, createMockLLMClient([boundaryConfidence]));
      const verdict = await g.check("goal", "goal-z", "Something at boundary");
      expect(verdict.verdict).toBe("pass");
    });
  });

  // ─── check() with context parameter ───

  describe("check() with additional context", () => {
    it("accepts and uses context without errors", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([PASS_VERDICT_JSON]));
      const verdict = await g.check(
        "subgoal",
        "subgoal-1",
        "Write unit tests",
        "Parent goal: Improve software quality to 95% test coverage"
      );
      expect(verdict.verdict).toBe("pass");
    });
  });

  // ─── checkMeans() ───

  describe("checkMeans()", () => {
    it("returns a pass verdict for safe task means", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([PASS_VERDICT_JSON]));
      const verdict = await g.checkMeans(
        "task-1",
        "Run automated tests",
        "Execute the test suite via npm test"
      );
      expect(verdict.verdict).toBe("pass");
    });

    it("returns a flag verdict for concerning task means", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([FLAG_VERDICT_JSON]));
      const verdict = await g.checkMeans(
        "task-2",
        "Collect user data",
        "Scrape user browsing history without consent"
      );
      expect(verdict.verdict).toBe("flag");
    });

    it("returns a reject verdict for clearly unethical means", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([REJECT_VERDICT_JSON]));
      const verdict = await g.checkMeans(
        "task-3",
        "Gain access to system",
        "Exploit a known security vulnerability"
      );
      expect(verdict.verdict).toBe("reject");
    });

    it("auto-flags when confidence < 0.6 (same as check())", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([LOW_CONFIDENCE_PASS_JSON]));
      const verdict = await g.checkMeans(
        "task-4",
        "Ambiguous task",
        "Some uncertain means"
      );
      expect(verdict.verdict).toBe("flag");
    });

    it("persists a log entry with subject_type 'task'", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([PASS_VERDICT_JSON]));
      await g.checkMeans("task-5", "Build feature", "Use standard TDD approach");
      const logs = g.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0]!.subject_type).toBe("task");
      expect(logs[0]!.subject_id).toBe("task-5");
    });
  });

  // ─── getLogs() — all logs ───

  describe("getLogs() returns all logs", () => {
    it("returns empty array when no checks have been run", () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([]));
      expect(g.getLogs()).toEqual([]);
    });

    it("returns one log after one check", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([PASS_VERDICT_JSON]));
      await g.check("goal", "goal-1", "Improve quality");
      const logs = g.getLogs();
      expect(logs).toHaveLength(1);
    });

    it("returns all logs after multiple checks", async () => {
      const g = new EthicsGate(
        stateManager,
        createMockLLMClient([PASS_VERDICT_JSON, REJECT_VERDICT_JSON, FLAG_VERDICT_JSON])
      );
      await g.check("goal", "goal-1", "First goal");
      await g.check("goal", "goal-2", "Second goal");
      await g.check("subgoal", "subgoal-1", "A subgoal");
      const logs = g.getLogs();
      expect(logs).toHaveLength(3);
    });
  });

  // ─── getLogs() — filter by subjectId ───

  describe("getLogs() with subjectId filter", () => {
    it("returns only logs matching the given subjectId", async () => {
      const g = new EthicsGate(
        stateManager,
        createMockLLMClient([PASS_VERDICT_JSON, FLAG_VERDICT_JSON, PASS_VERDICT_JSON])
      );
      await g.check("goal", "goal-A", "First");
      await g.check("goal", "goal-B", "Second");
      await g.check("goal", "goal-A", "Third (same id as first)");

      const filtered = g.getLogs({ subjectId: "goal-A" });
      expect(filtered).toHaveLength(2);
      expect(filtered.every((l) => l.subject_id === "goal-A")).toBe(true);
    });

    it("returns empty array when no logs match the subjectId", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([PASS_VERDICT_JSON]));
      await g.check("goal", "goal-1", "Something");
      const filtered = g.getLogs({ subjectId: "nonexistent-id" });
      expect(filtered).toHaveLength(0);
    });
  });

  // ─── getLogs() — filter by verdict ───

  describe("getLogs() with verdict filter", () => {
    it("returns only 'pass' logs", async () => {
      const g = new EthicsGate(
        stateManager,
        createMockLLMClient([PASS_VERDICT_JSON, REJECT_VERDICT_JSON, FLAG_VERDICT_JSON])
      );
      await g.check("goal", "g1", "Safe goal");
      await g.check("goal", "g2", "Bad goal");
      await g.check("goal", "g3", "Flagged goal");

      const passing = g.getLogs({ verdict: "pass" });
      expect(passing).toHaveLength(1);
      expect(passing[0]!.verdict.verdict).toBe("pass");
    });

    it("returns only 'reject' logs", async () => {
      const g = new EthicsGate(
        stateManager,
        createMockLLMClient([PASS_VERDICT_JSON, REJECT_VERDICT_JSON, FLAG_VERDICT_JSON])
      );
      await g.check("goal", "g1", "Safe goal");
      await g.check("goal", "g2", "Bad goal");
      await g.check("goal", "g3", "Flagged goal");

      const rejected = g.getLogs({ verdict: "reject" });
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.verdict.verdict).toBe("reject");
    });

    it("returns only 'flag' logs", async () => {
      const g = new EthicsGate(
        stateManager,
        createMockLLMClient([PASS_VERDICT_JSON, REJECT_VERDICT_JSON, FLAG_VERDICT_JSON])
      );
      await g.check("goal", "g1", "Safe goal");
      await g.check("goal", "g2", "Bad goal");
      await g.check("goal", "g3", "Flagged goal");

      const flagged = g.getLogs({ verdict: "flag" });
      expect(flagged).toHaveLength(1);
      expect(flagged[0]!.verdict.verdict).toBe("flag");
    });

    it("can combine subjectId and verdict filters", async () => {
      const g = new EthicsGate(
        stateManager,
        createMockLLMClient([PASS_VERDICT_JSON, FLAG_VERDICT_JSON, PASS_VERDICT_JSON])
      );
      await g.check("goal", "goal-A", "First pass");
      await g.check("goal", "goal-A", "First flag");
      await g.check("goal", "goal-B", "Second pass");

      const filtered = g.getLogs({ subjectId: "goal-A", verdict: "pass" });
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.subject_id).toBe("goal-A");
      expect(filtered[0]!.verdict.verdict).toBe("pass");
    });
  });

  // ─── Log persistence ───

  describe("log persistence", () => {
    it("persists logs to ethics/ethics-log.json", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([PASS_VERDICT_JSON]));
      await g.check("goal", "goal-1", "A goal");

      const filePath = path.join(tmpDir, "ethics", "ethics-log.json");
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it("log file contains valid JSON array", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([PASS_VERDICT_JSON]));
      await g.check("goal", "goal-1", "A goal");

      const filePath = path.join(tmpDir, "ethics", "ethics-log.json");
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
    });

    it("a fresh EthicsGate instance reads back persisted logs", async () => {
      const g1 = new EthicsGate(stateManager, createMockLLMClient([PASS_VERDICT_JSON]));
      await g1.check("goal", "goal-persist", "Persisted goal");

      // New instance pointing to the same stateManager
      const g2 = new EthicsGate(stateManager, createMockLLMClient([]));
      const logs = g2.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0]!.subject_id).toBe("goal-persist");
    });

    it("accumulates logs across multiple checks correctly", async () => {
      const g = new EthicsGate(
        stateManager,
        createMockLLMClient([PASS_VERDICT_JSON, FLAG_VERDICT_JSON, REJECT_VERDICT_JSON])
      );
      await g.check("goal", "g1", "Goal 1");
      await g.check("subgoal", "sg1", "Subgoal 1");
      await g.check("task", "t1", "Task 1");

      const logs = g.getLogs();
      expect(logs).toHaveLength(3);
      expect(logs[0]!.subject_type).toBe("goal");
      expect(logs[1]!.subject_type).toBe("subgoal");
      expect(logs[2]!.subject_type).toBe("task");
    });

    it("log entries have unique log_ids", async () => {
      const g = new EthicsGate(
        stateManager,
        createMockLLMClient([PASS_VERDICT_JSON, PASS_VERDICT_JSON])
      );
      await g.check("goal", "g1", "First");
      await g.check("goal", "g2", "Second");

      const logs = g.getLogs();
      expect(logs[0]!.log_id).not.toBe(logs[1]!.log_id);
    });

    it("log entries have timestamps", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([PASS_VERDICT_JSON]));
      await g.check("goal", "g1", "A goal");

      const logs = g.getLogs();
      expect(logs[0]!.timestamp).toBeTruthy();
      // Should be a valid ISO string
      expect(() => new Date(logs[0]!.timestamp)).not.toThrow();
    });

    it("does not leave .tmp files after write", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([PASS_VERDICT_JSON]));
      await g.check("goal", "g1", "A goal");

      const ethicsDir = path.join(tmpDir, "ethics");
      if (fs.existsSync(ethicsDir)) {
        const files = fs.readdirSync(ethicsDir);
        expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
      }
    });
  });

  // ─── JSON parse failure — conservative fallback ───

  describe("JSON parse failure returns conservative fallback", () => {
    it("returns verdict 'flag' when LLM response is not valid JSON", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([MALFORMED_JSON]));
      const verdict = await g.check("goal", "g-err", "Any goal");
      expect(verdict.verdict).toBe("flag");
    });

    it("returns category 'parse_error' on parse failure", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([MALFORMED_JSON]));
      const verdict = await g.check("goal", "g-err", "Any goal");
      expect(verdict.category).toBe("parse_error");
    });

    it("returns confidence 0 on parse failure", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([MALFORMED_JSON]));
      const verdict = await g.check("goal", "g-err", "Any goal");
      expect(verdict.confidence).toBe(0);
    });

    it("returns empty risks array on parse failure", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([MALFORMED_JSON]));
      const verdict = await g.check("goal", "g-err", "Any goal");
      expect(verdict.risks).toEqual([]);
    });

    it("still persists a log entry on parse failure", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([MALFORMED_JSON]));
      await g.check("goal", "g-err", "Any goal");
      const logs = g.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0]!.verdict.verdict).toBe("flag");
    });

    it("checkMeans() also returns conservative fallback on parse failure", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([MALFORMED_JSON]));
      const verdict = await g.checkMeans("t-err", "Some task", "Some means");
      expect(verdict.verdict).toBe("flag");
      expect(verdict.category).toBe("parse_error");
    });
  });

  // ─── LLM call failure propagates ───

  describe("LLM call failure propagates", () => {
    it("throws when LLM sendMessage rejects", async () => {
      const failingClient: ILLMClient = {
        async sendMessage(): Promise<LLMResponse> {
          throw new Error("Network error");
        },
        parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
          return schema.parse(JSON.parse(content));
        },
      };
      const g = new EthicsGate(stateManager, failingClient);
      await expect(g.check("goal", "g-fail", "Any goal")).rejects.toThrow("Network error");
    });
  });

  // ─── Log structure validation ───

  describe("log structure", () => {
    it("log entry includes all required fields", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([PASS_VERDICT_JSON]));
      await g.check("goal", "goal-struct", "Test structure");

      const logs = g.getLogs();
      const entry = logs[0]!;
      expect(entry.log_id).toBeTruthy();
      expect(entry.timestamp).toBeTruthy();
      expect(entry.subject_type).toBe("goal");
      expect(entry.subject_id).toBe("goal-struct");
      expect(entry.subject_description).toBe("Test structure");
      expect(entry.verdict).toBeDefined();
      expect(entry.verdict.verdict).toBe("pass");
    });

    it("auto-flagged entry reflects overridden verdict in log", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([LOW_CONFIDENCE_PASS_JSON]));
      await g.check("goal", "goal-flagged", "Low confidence goal");

      const logs = g.getLogs();
      expect(logs[0]!.verdict.verdict).toBe("flag");
      // Original confidence is preserved
      expect(logs[0]!.verdict.confidence).toBe(0.30);
    });

    it("supports all three subject types in logs", async () => {
      const g = new EthicsGate(
        stateManager,
        createMockLLMClient([PASS_VERDICT_JSON, PASS_VERDICT_JSON, PASS_VERDICT_JSON])
      );
      await g.check("goal", "g1", "Goal");
      await g.check("subgoal", "sg1", "Subgoal");
      await g.check("task", "t1", "Task");

      const logs = g.getLogs();
      const types = logs.map((l) => l.subject_type);
      expect(types).toContain("goal");
      expect(types).toContain("subgoal");
      expect(types).toContain("task");
    });
  });

  // ─── high confidence flag stays flag ───

  describe("check() preserves flag verdict with high confidence", () => {
    it("does not change 'flag' verdict even at high confidence", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([HIGH_CONFIDENCE_FLAG_JSON]));
      const verdict = await g.check("goal", "g1", "Something flagged");
      expect(verdict.verdict).toBe("flag");
      expect(verdict.confidence).toBe(0.75);
    });
  });
});
