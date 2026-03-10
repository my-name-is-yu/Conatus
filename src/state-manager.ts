import * as fs from "node:fs";
import * as path from "node:path";
import { GoalSchema, GoalTreeSchema } from "./types/goal.js";
import { ObservationLogSchema, ObservationLogEntrySchema } from "./types/state.js";
import { GapHistoryEntrySchema } from "./types/gap.js";
import type { Goal, GoalTree } from "./types/goal.js";
import type { ObservationLog, ObservationLogEntry } from "./types/state.js";
import type { GapHistoryEntry } from "./types/gap.js";

/**
 * StateManager handles persistence of goals, state vectors, observation logs,
 * and gap history under a base directory (default: ~/.motiva/).
 *
 * File layout:
 *   <base>/goals/<goal_id>/goal.json
 *   <base>/goals/<goal_id>/observations.json
 *   <base>/goals/<goal_id>/gap-history.json
 *   <base>/goal-trees/<root_id>.json
 *   <base>/events/              (event queue directory)
 *   <base>/events/archive/      (processed events)
 *   <base>/reports/             (report output directory)
 *
 * All writes are atomic: write to .tmp file, then rename.
 */
export class StateManager {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(process.env.HOME ?? "~", ".motiva");
    this.ensureDirectories();
  }

  /** Returns the base directory path */
  getBaseDir(): string {
    return this.baseDir;
  }

  // ─── Directory Management ───

  private ensureDirectories(): void {
    const dirs = [
      this.baseDir,
      path.join(this.baseDir, "goals"),
      path.join(this.baseDir, "goal-trees"),
      path.join(this.baseDir, "events"),
      path.join(this.baseDir, "events", "archive"),
      path.join(this.baseDir, "reports"),
      path.join(this.baseDir, "reports", "daily"),
      path.join(this.baseDir, "reports", "weekly"),
      path.join(this.baseDir, "reports", "notifications"),
    ];
    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private goalDir(goalId: string): string {
    const dir = path.join(this.baseDir, "goals", goalId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ─── Atomic Write ───

  private atomicWrite(filePath: string, data: unknown): void {
    const tmpPath = filePath + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpPath, filePath);
  }

  private readJsonFile<T>(filePath: string): T | null {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as T;
  }

  // ─── Goal CRUD ───

  saveGoal(goal: Goal): void {
    const parsed = GoalSchema.parse(goal);
    const dir = this.goalDir(parsed.id);
    this.atomicWrite(path.join(dir, "goal.json"), parsed);
  }

  loadGoal(goalId: string): Goal | null {
    const filePath = path.join(this.baseDir, "goals", goalId, "goal.json");
    const raw = this.readJsonFile<unknown>(filePath);
    if (raw === null) return null;
    return GoalSchema.parse(raw);
  }

  deleteGoal(goalId: string): boolean {
    const dir = path.join(this.baseDir, "goals", goalId);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }

  listGoalIds(): string[] {
    const goalsDir = path.join(this.baseDir, "goals");
    if (!fs.existsSync(goalsDir)) return [];
    return fs
      .readdirSync(goalsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  // ─── Goal Tree ───

  saveGoalTree(tree: GoalTree): void {
    const parsed = GoalTreeSchema.parse(tree);
    const filePath = path.join(
      this.baseDir,
      "goal-trees",
      `${parsed.root_id}.json`
    );
    this.atomicWrite(filePath, parsed);
  }

  loadGoalTree(rootId: string): GoalTree | null {
    const filePath = path.join(this.baseDir, "goal-trees", `${rootId}.json`);
    const raw = this.readJsonFile<unknown>(filePath);
    if (raw === null) return null;
    return GoalTreeSchema.parse(raw);
  }

  deleteGoalTree(rootId: string): boolean {
    const filePath = path.join(this.baseDir, "goal-trees", `${rootId}.json`);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  // ─── Observation Log ───

  saveObservationLog(log: ObservationLog): void {
    const parsed = ObservationLogSchema.parse(log);
    const dir = this.goalDir(parsed.goal_id);
    this.atomicWrite(path.join(dir, "observations.json"), parsed);
  }

  loadObservationLog(goalId: string): ObservationLog | null {
    const filePath = path.join(
      this.baseDir,
      "goals",
      goalId,
      "observations.json"
    );
    const raw = this.readJsonFile<unknown>(filePath);
    if (raw === null) return null;
    return ObservationLogSchema.parse(raw);
  }

  appendObservation(goalId: string, entry: ObservationLogEntry): void {
    const parsed = ObservationLogEntrySchema.parse(entry);
    if (parsed.goal_id !== goalId) {
      throw new Error(
        `appendObservation: entry.goal_id ("${parsed.goal_id}") does not match goalId ("${goalId}")`
      );
    }
    let log = this.loadObservationLog(goalId);
    if (log === null) {
      log = { goal_id: goalId, entries: [] };
    }
    log.entries.push(parsed);
    this.saveObservationLog(log);
  }

  // ─── Gap History ───

  saveGapHistory(goalId: string, history: GapHistoryEntry[]): void {
    const parsed = history.map((e) => GapHistoryEntrySchema.parse(e));
    const dir = this.goalDir(goalId);
    this.atomicWrite(path.join(dir, "gap-history.json"), parsed);
  }

  loadGapHistory(goalId: string): GapHistoryEntry[] {
    const filePath = path.join(
      this.baseDir,
      "goals",
      goalId,
      "gap-history.json"
    );
    const raw = this.readJsonFile<unknown[]>(filePath);
    if (raw === null) return [];
    return raw.map((e) => GapHistoryEntrySchema.parse(e));
  }

  appendGapHistoryEntry(goalId: string, entry: GapHistoryEntry): void {
    const parsed = GapHistoryEntrySchema.parse(entry);
    const history = this.loadGapHistory(goalId);
    history.push(parsed);
    this.saveGapHistory(goalId, history);
  }

  // ─── Utility ───

  /** Check whether a goal directory exists */
  goalExists(goalId: string): boolean {
    return fs.existsSync(
      path.join(this.baseDir, "goals", goalId, "goal.json")
    );
  }

  /** Read raw JSON from any path relative to base dir */
  readRaw(relativePath: string): unknown | null {
    const filePath = path.join(this.baseDir, relativePath);
    return this.readJsonFile<unknown>(filePath);
  }

  /** Write raw JSON to any path relative to base dir (atomic) */
  writeRaw(relativePath: string, data: unknown): void {
    const filePath = path.join(this.baseDir, relativePath);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    this.atomicWrite(filePath, data);
  }
}
