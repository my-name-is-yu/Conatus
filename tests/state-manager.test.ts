import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state-manager.js";
import type { Goal, GoalTree } from "../src/types/goal.js";
import type { ObservationLogEntry } from "../src/types/state.js";
import type { GapHistoryEntry } from "../src/types/gap.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-test-"));
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? crypto.randomUUID(),
    parent_id: null,
    node_type: "goal",
    title: "Test Goal",
    description: "",
    status: "active",
    dimensions: [
      {
        name: "test_dim",
        label: "Test Dimension",
        current_value: 50,
        threshold: { type: "min", value: 100 },
        confidence: 0.9,
        observation_method: {
          type: "mechanical",
          source: "test",
          schedule: null,
          endpoint: null,
          confidence_tier: "mechanical",
        },
        last_updated: now,
        history: [],
        weight: 1.0,
        uncertainty_weight: null,
      },
    ],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: null,
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("StateManager", () => {
  let tmpDir: string;
  let manager: StateManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    manager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("directory structure", () => {
    it("creates base directories on construction", () => {
      expect(fs.existsSync(path.join(tmpDir, "goals"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "goal-trees"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "events"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "events", "archive"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "reports"))).toBe(true);
    });

    it("returns the base directory path", () => {
      expect(manager.getBaseDir()).toBe(tmpDir);
    });
  });

  describe("Goal CRUD", () => {
    it("saves and loads a goal", () => {
      const goal = makeGoal({ id: "goal-1", title: "My Goal" });
      manager.saveGoal(goal);
      const loaded = manager.loadGoal("goal-1");
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe("goal-1");
      expect(loaded!.title).toBe("My Goal");
      expect(loaded!.dimensions).toHaveLength(1);
      expect(loaded!.dimensions[0].name).toBe("test_dim");
    });

    it("returns null for non-existent goal", () => {
      const loaded = manager.loadGoal("nonexistent");
      expect(loaded).toBeNull();
    });

    it("overwrites existing goal on save", () => {
      const goal = makeGoal({ id: "goal-1", title: "Original" });
      manager.saveGoal(goal);

      const updated = makeGoal({ id: "goal-1", title: "Updated" });
      manager.saveGoal(updated);

      const loaded = manager.loadGoal("goal-1");
      expect(loaded!.title).toBe("Updated");
    });

    it("deletes a goal", () => {
      const goal = makeGoal({ id: "goal-del" });
      manager.saveGoal(goal);
      expect(manager.goalExists("goal-del")).toBe(true);

      const result = manager.deleteGoal("goal-del");
      expect(result).toBe(true);
      expect(manager.goalExists("goal-del")).toBe(false);
      expect(manager.loadGoal("goal-del")).toBeNull();
    });

    it("returns false when deleting non-existent goal", () => {
      expect(manager.deleteGoal("nope")).toBe(false);
    });

    it("lists goal IDs", () => {
      manager.saveGoal(makeGoal({ id: "g1" }));
      manager.saveGoal(makeGoal({ id: "g2" }));
      manager.saveGoal(makeGoal({ id: "g3" }));

      const ids = manager.listGoalIds();
      expect(ids.sort()).toEqual(["g1", "g2", "g3"]);
    });

    it("goalExists returns correct values", () => {
      expect(manager.goalExists("nope")).toBe(false);
      manager.saveGoal(makeGoal({ id: "exists" }));
      expect(manager.goalExists("exists")).toBe(true);
    });
  });

  describe("atomic writes", () => {
    it("does not leave .tmp files after successful write", () => {
      const goal = makeGoal({ id: "atomic-test" });
      manager.saveGoal(goal);

      const goalDir = path.join(tmpDir, "goals", "atomic-test");
      const files = fs.readdirSync(goalDir);
      expect(files).toContain("goal.json");
      expect(files.filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
    });

    it("writes valid JSON that can be parsed", () => {
      const goal = makeGoal({ id: "json-test" });
      manager.saveGoal(goal);

      const filePath = path.join(tmpDir, "goals", "json-test", "goal.json");
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed.id).toBe("json-test");
    });
  });

  describe("Goal Tree", () => {
    it("saves and loads a goal tree", () => {
      const goal1 = makeGoal({ id: "root", children_ids: ["child1"] });
      const goal2 = makeGoal({ id: "child1", parent_id: "root", node_type: "subgoal" });

      const tree: GoalTree = {
        root_id: "root",
        goals: {
          root: goal1,
          child1: goal2,
        },
      };

      manager.saveGoalTree(tree);
      const loaded = manager.loadGoalTree("root");
      expect(loaded).not.toBeNull();
      expect(loaded!.root_id).toBe("root");
      expect(Object.keys(loaded!.goals)).toHaveLength(2);
    });

    it("returns null for non-existent tree", () => {
      expect(manager.loadGoalTree("nonexistent")).toBeNull();
    });

    it("deletes a goal tree", () => {
      const tree: GoalTree = {
        root_id: "del-tree",
        goals: {
          "del-tree": makeGoal({ id: "del-tree" }),
        },
      };
      manager.saveGoalTree(tree);
      expect(manager.deleteGoalTree("del-tree")).toBe(true);
      expect(manager.loadGoalTree("del-tree")).toBeNull();
    });
  });

  describe("Observation Log", () => {
    it("saves and loads observation log", () => {
      const log = {
        goal_id: "obs-goal",
        entries: [
          {
            observation_id: "obs-1",
            timestamp: new Date().toISOString(),
            trigger: "post_task" as const,
            goal_id: "obs-goal",
            dimension_name: "test_dim",
            layer: "mechanical" as const,
            method: {
              type: "mechanical" as const,
              source: "test",
              schedule: null,
              endpoint: null,
              confidence_tier: "mechanical" as const,
            },
            raw_result: { value: 42 },
            extracted_value: 42,
            confidence: 0.95,
            notes: null,
          },
        ],
      };

      // Save the goal first so the directory exists
      manager.saveGoal(makeGoal({ id: "obs-goal" }));
      manager.saveObservationLog(log);

      const loaded = manager.loadObservationLog("obs-goal");
      expect(loaded).not.toBeNull();
      expect(loaded!.entries).toHaveLength(1);
      expect(loaded!.entries[0].observation_id).toBe("obs-1");
    });

    it("appends observations", () => {
      manager.saveGoal(makeGoal({ id: "append-obs" }));

      const entry1: ObservationLogEntry = {
        observation_id: "obs-a",
        timestamp: new Date().toISOString(),
        trigger: "periodic",
        goal_id: "append-obs",
        dimension_name: "dim1",
        layer: "mechanical",
        method: {
          type: "api_query",
          source: "api",
          schedule: null,
          endpoint: null,
          confidence_tier: "mechanical",
        },
        raw_result: 10,
        extracted_value: 10,
        confidence: 0.9,
        notes: null,
      };

      const entry2: ObservationLogEntry = {
        ...entry1,
        observation_id: "obs-b",
        extracted_value: 20,
      };

      manager.appendObservation("append-obs", entry1);
      manager.appendObservation("append-obs", entry2);

      const loaded = manager.loadObservationLog("append-obs");
      expect(loaded!.entries).toHaveLength(2);
      expect(loaded!.entries[0].observation_id).toBe("obs-a");
      expect(loaded!.entries[1].observation_id).toBe("obs-b");
    });

    it("returns null for non-existent observation log", () => {
      expect(manager.loadObservationLog("nope")).toBeNull();
    });
  });

  describe("Gap History", () => {
    it("saves and loads gap history", () => {
      manager.saveGoal(makeGoal({ id: "gap-goal" }));

      const history: GapHistoryEntry[] = [
        {
          iteration: 1,
          timestamp: new Date().toISOString(),
          gap_vector: [
            { dimension_name: "dim1", normalized_weighted_gap: 0.5 },
          ],
          confidence_vector: [{ dimension_name: "dim1", confidence: 0.9 }],
        },
      ];

      manager.saveGapHistory("gap-goal", history);
      const loaded = manager.loadGapHistory("gap-goal");
      expect(loaded).toHaveLength(1);
      expect(loaded[0].iteration).toBe(1);
    });

    it("appends gap history entries", () => {
      manager.saveGoal(makeGoal({ id: "gap-append" }));

      const entry1: GapHistoryEntry = {
        iteration: 1,
        timestamp: new Date().toISOString(),
        gap_vector: [{ dimension_name: "d", normalized_weighted_gap: 0.8 }],
        confidence_vector: [{ dimension_name: "d", confidence: 0.5 }],
      };

      const entry2: GapHistoryEntry = {
        iteration: 2,
        timestamp: new Date().toISOString(),
        gap_vector: [{ dimension_name: "d", normalized_weighted_gap: 0.6 }],
        confidence_vector: [{ dimension_name: "d", confidence: 0.7 }],
      };

      manager.appendGapHistoryEntry("gap-append", entry1);
      manager.appendGapHistoryEntry("gap-append", entry2);

      const loaded = manager.loadGapHistory("gap-append");
      expect(loaded).toHaveLength(2);
      expect(loaded[0].gap_vector[0].normalized_weighted_gap).toBe(0.8);
      expect(loaded[1].gap_vector[0].normalized_weighted_gap).toBe(0.6);
    });

    it("returns empty array for non-existent gap history", () => {
      expect(manager.loadGapHistory("nonexistent")).toEqual([]);
    });
  });

  describe("raw read/write", () => {
    it("writes and reads arbitrary JSON", () => {
      manager.writeRaw("custom/data.json", { hello: "world" });
      const loaded = manager.readRaw("custom/data.json");
      expect(loaded).toEqual({ hello: "world" });
    });

    it("returns null for non-existent raw path", () => {
      expect(manager.readRaw("does/not/exist.json")).toBeNull();
    });
  });
});
