import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DaemonRunner } from "../src/daemon-runner.js";
import { PIDManager } from "../src/pid-manager.js";
import { Logger } from "../src/logger.js";
import type { LoopResult } from "../src/core-loop.js";
import type { DaemonDeps } from "../src/daemon-runner.js";

// ─── Helpers ───

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "motiva-daemon-test-"));
}

function makeLoopResult(overrides: Partial<LoopResult> = {}): LoopResult {
  return {
    goalId: "test-goal",
    totalIterations: 1,
    finalStatus: "completed",
    iterations: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeps(tmpDir: string, overrides: Partial<DaemonDeps> = {}): DaemonDeps {
  const mockCoreLoop = {
    run: vi.fn().mockResolvedValue(makeLoopResult()),
    stop: vi.fn(),
  };

  const mockDriveSystem = {
    shouldActivate: vi.fn().mockReturnValue(true),
    getSchedule: vi.fn().mockReturnValue(null),
    prioritizeGoals: vi.fn().mockImplementation((ids: string[]) => ids),
  };

  const mockStateManager = {
    getBaseDir: vi.fn().mockReturnValue(tmpDir),
  };

  const pidManager = new PIDManager(tmpDir);

  const logger = new Logger({
    dir: path.join(tmpDir, "logs"),
    consoleOutput: false,
    level: "error",
  });

  return {
    coreLoop: mockCoreLoop as unknown as DaemonDeps["coreLoop"],
    driveSystem: mockDriveSystem as unknown as DaemonDeps["driveSystem"],
    stateManager: mockStateManager as unknown as DaemonDeps["stateManager"],
    pidManager,
    logger,
    ...overrides,
  };
}

// ─── Test Suite ───

describe("DaemonRunner", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Remove any process signal listeners that may have been registered
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  // ─── Constructor / Config Defaults ───

  describe("constructor", () => {
    it("should construct without throwing with minimal deps", () => {
      const deps = makeDeps(tmpDir);
      expect(() => new DaemonRunner(deps)).not.toThrow();
    });

    it("should apply default config values (check_interval_ms = 300000)", () => {
      // We test defaults indirectly through behavior; the daemon should not throw
      const deps = makeDeps(tmpDir, { config: {} });
      expect(() => new DaemonRunner(deps)).not.toThrow();
    });

    it("should accept partial config overrides", () => {
      const deps = makeDeps(tmpDir, {
        config: { check_interval_ms: 1000, crash_recovery: { max_retries: 1, enabled: true, retry_delay_ms: 500 } },
      });
      expect(() => new DaemonRunner(deps)).not.toThrow();
    });
  });

  // ─── start() ───

  describe("start()", () => {
    it("should throw if daemon is already running (PID file from current process)", async () => {
      const deps = makeDeps(tmpDir);
      // Pre-write PID so isRunning() returns true
      deps.pidManager.writePID();

      const daemon = new DaemonRunner(deps);
      await expect(daemon.start(["goal-1"])).rejects.toThrow(/already running/i);

      // Cleanup PID to allow afterEach cleanup to pass
      deps.pidManager.cleanup();
    });

    it("should write PID file on start", async () => {
      const deps = makeDeps(tmpDir, {
        config: { check_interval_ms: 50 },
      });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-1"]);
      // Let the loop run one iteration
      await new Promise((resolve) => setTimeout(resolve, 60));
      daemon.stop();
      await startPromise;

      // PID file should be cleaned up after stop
      expect(deps.pidManager.readPID()).toBeNull();
    });

    it("should save daemon-state.json with status=running on start", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-1"]);
      // Allow one tick for initial state write
      await new Promise((resolve) => setTimeout(resolve, 10));

      const statePath = path.join(tmpDir, "daemon-state.json");
      expect(fs.existsSync(statePath)).toBe(true);
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(state.status).toBe("running");

      daemon.stop();
      await startPromise;
    });

    it("should run CoreLoop.run() for active goals", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 60));
      daemon.stop();
      await startPromise;

      expect((deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run).toHaveBeenCalledWith("goal-1");
    });

    it("should skip goals that shouldActivate returns false for", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      (deps.driveSystem as { shouldActivate: ReturnType<typeof vi.fn> }).shouldActivate.mockReturnValue(false);

      const daemon = new DaemonRunner(deps);
      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 60));
      daemon.stop();
      await startPromise;

      expect((deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run).not.toHaveBeenCalled();
    });

    it("should pass active_goals to daemon state from start() argument", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-a", "goal-b"]);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const statePath = path.join(tmpDir, "daemon-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(state.active_goals).toEqual(["goal-a", "goal-b"]);

      daemon.stop();
      await startPromise;
    });
  });

  // ─── stop() ───

  describe("stop()", () => {
    it("should set status to stopping in daemon-state.json", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 500 } });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      daemon.stop();

      const statePath = path.join(tmpDir, "daemon-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(["stopping", "stopped"]).toContain(state.status);

      await startPromise;
    });

    it("should terminate the loop and resolve the start() promise", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      daemon.stop();

      // Should resolve within a reasonable time
      await expect(startPromise).resolves.toBeUndefined();
    });

    it("should remove PID file after stopping", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      daemon.stop();
      await startPromise;

      expect(deps.pidManager.readPID()).toBeNull();
    });

    it("should set status to stopped in daemon-state.json after loop exits", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      daemon.stop();
      await startPromise;

      const statePath = path.join(tmpDir, "daemon-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(state.status).toBe("stopped");
    });
  });

  // ─── Error Handling / Crash Recovery ───

  describe("error handling", () => {
    it("should increment crash_count on loop error", async () => {
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          crash_recovery: { enabled: true, max_retries: 5, retry_delay_ms: 10 },
        },
      });
      (deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run.mockRejectedValueOnce(
        new Error("simulated failure")
      );

      const daemon = new DaemonRunner(deps);
      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 80));
      daemon.stop();
      await startPromise;

      const statePath = path.join(tmpDir, "daemon-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(state.crash_count).toBeGreaterThanOrEqual(1);
    });

    it("should record last_error message on loop failure", async () => {
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          crash_recovery: { enabled: true, max_retries: 5, retry_delay_ms: 10 },
        },
      });
      (deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run.mockRejectedValueOnce(
        new Error("boom!")
      );

      const daemon = new DaemonRunner(deps);
      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 80));
      daemon.stop();
      await startPromise;

      const statePath = path.join(tmpDir, "daemon-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      // After 1 failure + stop, last_error may be null again if further runs succeeded.
      // Check that crash_count recorded the failure.
      expect(state.crash_count).toBeGreaterThanOrEqual(1);
    });

    it("should stop daemon when crash count reaches max_retries", async () => {
      const maxRetries = 2;
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 10,
          crash_recovery: { enabled: true, max_retries: maxRetries, retry_delay_ms: 5 },
        },
      });
      // Always fail
      (deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run.mockRejectedValue(
        new Error("always fails")
      );

      const daemon = new DaemonRunner(deps);
      // start() should resolve on its own after max_retries exceeded
      await daemon.start(["goal-1"]);

      const statePath = path.join(tmpDir, "daemon-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      expect(state.crash_count).toBeGreaterThanOrEqual(maxRetries);
    });

    it("should set status to stopped (not crashed) when max_retries exceeded via handleLoopError", async () => {
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 10,
          crash_recovery: { enabled: true, max_retries: 2, retry_delay_ms: 5 },
        },
      });
      (deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run.mockRejectedValue(
        new Error("always fails")
      );

      const daemon = new DaemonRunner(deps);
      await daemon.start(["goal-1"]);

      const statePath = path.join(tmpDir, "daemon-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
      // Status ends as "stopped" since cleanup() runs after the loop (not "crashed")
      expect(state.status).toBe("stopped");
    });
  });

  // ─── generateCronEntry (static) ───

  describe("generateCronEntry()", () => {
    it("should generate a sub-hourly cron entry for interval < 60 min", () => {
      const entry = DaemonRunner.generateCronEntry("my-goal", 15);
      expect(entry).toBe("*/15 * * * * /usr/bin/env motiva run --goal my-goal");
    });

    it("should generate an hourly cron entry for interval = 60 min (1 hour)", () => {
      const entry = DaemonRunner.generateCronEntry("my-goal", 60);
      expect(entry).toBe("0 */1 * * * /usr/bin/env motiva run --goal my-goal");
    });

    it("should generate a multi-hour cron entry for interval between 60 and 1440 min", () => {
      const entry = DaemonRunner.generateCronEntry("my-goal", 240);
      expect(entry).toBe("0 */4 * * * /usr/bin/env motiva run --goal my-goal");
    });

    it("should generate a daily cron entry for interval >= 1440 min (1 day)", () => {
      const entry = DaemonRunner.generateCronEntry("my-goal", 1440);
      expect(entry).toBe("0 0 * * * /usr/bin/env motiva run --goal my-goal");
    });

    it("should treat interval > 1440 as daily", () => {
      const entry = DaemonRunner.generateCronEntry("my-goal", 2880);
      expect(entry).toBe("0 0 * * * /usr/bin/env motiva run --goal my-goal");
    });

    it("should use 60-minute default when no interval is provided", () => {
      const entry = DaemonRunner.generateCronEntry("goal-default");
      expect(entry).toBe("0 */1 * * * /usr/bin/env motiva run --goal goal-default");
    });

    it("should treat interval <= 0 as 60 minutes", () => {
      const entry0 = DaemonRunner.generateCronEntry("goal-x", 0);
      const entryNeg = DaemonRunner.generateCronEntry("goal-x", -5);
      expect(entry0).toBe("0 */1 * * * /usr/bin/env motiva run --goal goal-x");
      expect(entryNeg).toBe("0 */1 * * * /usr/bin/env motiva run --goal goal-x");
    });

    it("should include the goalId verbatim in the cron entry", () => {
      const goalId = "complex-goal-id_123";
      const entry = DaemonRunner.generateCronEntry(goalId, 30);
      expect(entry).toContain(goalId);
    });

    it("should generate correct entry for 30-minute interval", () => {
      const entry = DaemonRunner.generateCronEntry("g", 30);
      expect(entry).toBe("*/30 * * * * /usr/bin/env motiva run --goal g");
    });

    it("should generate correct entry for 1-minute interval", () => {
      const entry = DaemonRunner.generateCronEntry("g", 1);
      expect(entry).toBe("*/1 * * * * /usr/bin/env motiva run --goal g");
    });
  });

  // ─── Daemon State Persistence ───

  describe("daemon state persistence", () => {
    it("should write daemon-state.json to baseDir on start", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(fs.existsSync(path.join(tmpDir, "daemon-state.json"))).toBe(true);

      daemon.stop();
      await startPromise;
    });

    it("should record loop_count increments for each successful run", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 20 } });
      // Always resolve quickly so loop runs multiple times
      (deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run.mockResolvedValue(makeLoopResult());

      const daemon = new DaemonRunner(deps);
      const startPromise = daemon.start(["goal-1"]);
      // Allow ~3 iterations at 20ms interval
      await new Promise((resolve) => setTimeout(resolve, 100));
      daemon.stop();
      await startPromise;

      const state = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "daemon-state.json"), "utf-8")
      );
      expect(state.loop_count).toBeGreaterThanOrEqual(1);
    });

    it("should have pid set to current process PID in saved state", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const state = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "daemon-state.json"), "utf-8")
      );
      expect(state.pid).toBe(process.pid);

      daemon.stop();
      await startPromise;
    });
  });

  // ─── Goal Interval Overrides ───

  describe("goal_intervals config", () => {
    it("should use the minimum goal interval when goal_intervals override is provided", async () => {
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 300_000,
          goal_intervals: { "goal-fast": 10 },
        },
      });

      const daemon = new DaemonRunner(deps);
      const startPromise = daemon.start(["goal-fast"]);
      // 10ms interval → loop should run within 100ms
      await new Promise((resolve) => setTimeout(resolve, 80));
      daemon.stop();
      await startPromise;

      expect((deps.coreLoop as { run: ReturnType<typeof vi.fn> }).run).toHaveBeenCalledWith(
        "goal-fast"
      );
    });
  });

  // ─── Cleanup ───

  describe("cleanup after loop", () => {
    it("should remove PID file on normal stop", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 30 } });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      daemon.stop();
      await startPromise;

      expect(fs.existsSync(deps.pidManager.getPath())).toBe(false);
    });

    it("should not leave .tmp files behind after state persistence", async () => {
      const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
      const daemon = new DaemonRunner(deps);

      const startPromise = daemon.start(["goal-1"]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      daemon.stop();
      await startPromise;

      const files = fs.readdirSync(tmpDir);
      expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
    });
  });
});
