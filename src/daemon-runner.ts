import * as fs from "node:fs";
import * as path from "node:path";
import { CoreLoop } from "./core-loop.js";
import type { LoopResult } from "./core-loop.js";
import { DriveSystem } from "./drive-system.js";
import { StateManager } from "./state-manager.js";
import { PIDManager } from "./pid-manager.js";
import { Logger } from "./logger.js";
import type { DaemonConfig, DaemonState } from "./types/daemon.js";
import { DaemonConfigSchema, DaemonStateSchema } from "./types/daemon.js";

// ─── DaemonRunner ───
//
// Runs the Motiva CoreLoop continuously as a long-lived daemon process.
// Responsibilities:
//   - PID file management (prevent duplicate daemons)
//   - Signal handling (SIGINT/SIGTERM → graceful stop)
//   - Multi-goal scheduling (DriveSystem.shouldActivate per goal)
//   - Crash recovery (configurable max_retries before hard stop)
//   - Daemon state persistence (~/.motiva/daemon-state.json)
//
// The daemon loop:
//   1. Determine which goals need activation (shouldActivate)
//   2. Run CoreLoop.run(goalId) for each active goal
//   3. Save state and sleep until next check interval

export interface DaemonDeps {
  coreLoop: CoreLoop;
  driveSystem: DriveSystem;
  stateManager: StateManager;
  pidManager: PIDManager;
  logger: Logger;
  config?: Partial<DaemonConfig>;
}

export class DaemonRunner {
  private coreLoop: CoreLoop;
  private driveSystem: DriveSystem;
  private stateManager: StateManager;
  private pidManager: PIDManager;
  private logger: Logger;
  private config: DaemonConfig;
  private running = false;
  private state: DaemonState;
  private baseDir: string;

  constructor(deps: DaemonDeps) {
    this.coreLoop = deps.coreLoop;
    this.driveSystem = deps.driveSystem;
    this.stateManager = deps.stateManager;
    this.pidManager = deps.pidManager;
    this.logger = deps.logger;

    // Parse config with defaults via DaemonConfigSchema.parse()
    this.config = DaemonConfigSchema.parse(deps.config ?? {});

    // Resolve base directory from stateManager
    this.baseDir = this.stateManager.getBaseDir();

    // Initialize daemon state
    this.state = DaemonStateSchema.parse({
      pid: process.pid,
      started_at: new Date().toISOString(),
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "stopped",
      crash_count: 0,
      last_error: null,
    });
  }

  // ─── Public API ───

  /**
   * Start daemon loop for given goals.
   * Throws if daemon is already running.
   */
  async start(goalIds: string[]): Promise<void> {
    // 1. Check if already running
    if (this.pidManager.isRunning()) {
      const info = this.pidManager.readPID();
      throw new Error(
        `Daemon is already running (PID ${info?.pid ?? "unknown"}). ` +
          `Stop it first or remove the PID file at: ${this.pidManager.getPath()}`
      );
    }

    // 2. Write PID file
    this.pidManager.writePID();

    // 3. Set up signal handlers — use process.once() for graceful stop
    const shutdown = (): void => {
      this.logger.info("Received shutdown signal, stopping daemon...");
      this.stop();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    // 4. Save initial daemon state
    this.running = true;
    this.state = DaemonStateSchema.parse({
      pid: process.pid,
      started_at: new Date().toISOString(),
      last_loop_at: null,
      loop_count: 0,
      active_goals: goalIds,
      status: "running",
      crash_count: 0,
      last_error: null,
    });
    this.saveDaemonState();

    // 5. Log start
    this.logger.info("Daemon started", {
      pid: process.pid,
      goals: goalIds,
      check_interval_ms: this.config.check_interval_ms,
    });

    // 6. Run main loop
    try {
      await this.runLoop(goalIds);
    } finally {
      // Remove signal handlers if loop exits without signal
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    }
  }

  /**
   * Signal daemon to stop after current iteration completes.
   */
  stop(): void {
    this.running = false;
    this.state.status = "stopping";
    this.saveDaemonState();
    this.logger.info("Stop requested — daemon will stop after current iteration");
  }

  // ─── Private: Main Loop ───

  /**
   * Main daemon loop. Runs until this.running is false or a critical error occurs.
   */
  private async runLoop(goalIds: string[]): Promise<void> {
    while (this.running) {
      try {
        // 1. Determine which goals need activation
        const activeGoals = this.determineActiveGoals(goalIds);

        if (activeGoals.length === 0) {
          this.logger.info("No goals need activation this cycle", {
            checked: goalIds.length,
          });
        }

        // 2. Execute loop for each active goal
        for (const goalId of activeGoals) {
          if (!this.running) break;

          this.logger.info(`Running loop for goal: ${goalId}`);

          try {
            const result: LoopResult = await this.coreLoop.run(goalId);
            this.state.loop_count++;
            this.state.last_loop_at = new Date().toISOString();
            this.logger.info(`Loop completed for goal: ${goalId}`, {
              status: result.finalStatus,
              iterations: result.totalIterations,
            });
          } catch (err) {
            this.handleLoopError(goalId, err);
          }

          // Bail out of goal iteration if crash limit exceeded
          if (!this.running) break;
        }

        // 3. Save state
        this.saveDaemonState();

        // 4. Wait for next check interval
        if (this.running) {
          const intervalMs = this.getNextInterval(goalIds);
          this.logger.debug(`Sleeping for ${intervalMs}ms until next check`);
          await this.sleep(intervalMs);
        }
      } catch (err) {
        this.handleCriticalError(err);
      }
    }

    // Cleanup after loop exits
    this.cleanup();
  }

  // ─── Private: Goal Activation ───

  /**
   * Determine which goals should be activated this cycle.
   * Uses DriveSystem.shouldActivate() for each goal, then sorts by priority.
   */
  private determineActiveGoals(goalIds: string[]): string[] {
    const eligibleIds: string[] = [];
    const scores = new Map<string, number>();

    for (const goalId of goalIds) {
      if (this.driveSystem.shouldActivate(goalId)) {
        eligibleIds.push(goalId);
        // Load goal to get a rough priority signal (gap or drive score not available here)
        // Use schedule consecutive_actions as a tiebreaker — more urgent goals first
        const schedule = this.driveSystem.getSchedule(goalId);
        // Higher consecutive_actions = more urgent (stalled goal). Use inverse of next_check_at
        // as a proxy: goals that are most overdue rank highest.
        const nextCheckAt = schedule
          ? new Date(schedule.next_check_at).getTime()
          : 0;
        // Earlier next_check_at means more overdue → assign higher (inverted) score
        scores.set(goalId, -nextCheckAt);
      }
    }

    // Sort by priority: most overdue first
    return this.driveSystem.prioritizeGoals(eligibleIds, scores);
  }

  // ─── Private: Interval Calculation ───

  /**
   * Calculate the next check interval in milliseconds.
   * Uses per-goal override from config.goal_intervals if configured,
   * otherwise falls back to config.check_interval_ms.
   * Returns the minimum interval across all goals (so the daemon checks
   * as soon as the earliest goal is due).
   */
  private getNextInterval(goalIds: string[]): number {
    const goalIntervals = this.config.goal_intervals;

    if (!goalIntervals || goalIds.length === 0) {
      return this.config.check_interval_ms;
    }

    let minInterval = this.config.check_interval_ms;

    for (const goalId of goalIds) {
      const override = goalIntervals[goalId];
      if (override !== undefined && override < minInterval) {
        minInterval = override;
      }
    }

    return minInterval;
  }

  // ─── Private: Error Handling ───

  /**
   * Handle a non-critical loop error for a single goal.
   * Increments crash_count and stops daemon if max_retries exceeded.
   */
  private handleLoopError(goalId: string, err: unknown): void {
    this.state.last_error = err instanceof Error ? err.message : String(err);
    this.state.crash_count++;
    this.logger.error(`Loop error for goal ${goalId}`, {
      error: this.state.last_error,
      crash_count: this.state.crash_count,
      max_retries: this.config.crash_recovery.max_retries,
    });

    // If crash count exceeds max_retries, stop daemon
    if (this.state.crash_count >= this.config.crash_recovery.max_retries) {
      this.logger.error(
        `Max crash retries (${this.config.crash_recovery.max_retries}) exceeded, stopping daemon`
      );
      this.running = false;
    }
  }

  /**
   * Handle a critical daemon-level error (outer loop catch).
   * Marks state as crashed and stops the loop.
   */
  private handleCriticalError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.error("Critical daemon error", { error: msg });
    this.state.status = "crashed";
    this.state.last_error = msg;
    this.saveDaemonState();
    this.running = false;
  }

  // ─── Private: State Persistence ───

  /**
   * Save daemon state to {baseDir}/daemon-state.json atomically.
   */
  private saveDaemonState(): void {
    const statePath = path.join(this.baseDir, "daemon-state.json");
    const tmpPath = statePath + ".tmp";
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), "utf-8");
      fs.renameSync(tmpPath, statePath);
    } catch (err) {
      // Non-fatal — log but don't crash the daemon
      this.logger.warn("Failed to save daemon state", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Load daemon state from {baseDir}/daemon-state.json.
   * Returns null if the file doesn't exist or fails to parse.
   */
  private loadDaemonState(): DaemonState | null {
    const statePath = path.join(this.baseDir, "daemon-state.json");
    try {
      if (!fs.existsSync(statePath)) return null;
      const data = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      return DaemonStateSchema.parse(data);
    } catch {
      return null;
    }
  }

  // ─── Private: Cleanup ───

  /**
   * Perform cleanup after the loop exits: update state, remove PID file, log.
   */
  private cleanup(): void {
    // Only set to "stopped" if not already "crashed"
    if (this.state.status !== "crashed") {
      this.state.status = "stopped";
    }
    this.saveDaemonState();
    this.pidManager.cleanup();
    this.logger.info("Daemon stopped", {
      loop_count: this.state.loop_count,
      crash_count: this.state.crash_count,
    });
  }

  // ─── Private: Sleep ───

  /**
   * Sleep for the given number of milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── Static Utilities ───

  /**
   * Generate a crontab entry that runs `motiva run --goal <goalId>` on a schedule.
   *
   * Rules:
   *   intervalMinutes <= 0 → treated as 60
   *   intervalMinutes < 60 → every N minutes:   *\/N * * * *
   *   intervalMinutes < 1440 (1 day) → every N hours: 0 *\/N * * *
   *   intervalMinutes >= 1440 → once per day:   0 0 * * *
   */
  static generateCronEntry(goalId: string, intervalMinutes: number = 60): string {
    if (intervalMinutes <= 0) intervalMinutes = 60;

    if (intervalMinutes < 60) {
      return `*/${intervalMinutes} * * * * /usr/bin/env motiva run --goal ${goalId}`;
    }

    const hours = Math.floor(intervalMinutes / 60);
    if (hours < 24) {
      return `0 */${hours} * * * /usr/bin/env motiva run --goal ${goalId}`;
    }

    return `0 0 * * * /usr/bin/env motiva run --goal ${goalId}`;
  }
}
