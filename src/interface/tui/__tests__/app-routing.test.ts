import { describe, expect, it } from "vitest";
import {
  deriveDaemonGoalIdFromActiveGoals,
  isChatRunnerOwnedSlashCommand,
  resolveFreeformInputRoute,
} from "../app.js";

describe("TUI app routing helpers", () => {
  it("keeps free-form input on ChatRunner when daemon has an active goal", () => {
    expect(resolveFreeformInputRoute({
      isDaemonMode: true,
      daemonGoalId: "goal-1",
      hasChatRunner: true,
    })).toBe("chat_runner");
  });

  it("falls back to daemon goal chat only when ChatRunner is unavailable", () => {
    expect(resolveFreeformInputRoute({
      isDaemonMode: true,
      daemonGoalId: "goal-1",
      hasChatRunner: false,
    })).toBe("daemon_goal_chat");
  });

  it("recognizes ChatRunner-owned slash commands from the TUI surface", () => {
    expect(isChatRunnerOwnedSlashCommand("/resume Work Session")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/sessions")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/title Work Session")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/cleanup --dry-run")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/status")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/status goal-1")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/history saved")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/compact")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/context")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/working-memory")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/goals")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/tasks goal-1")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/task task-1 goal-1")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/track")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/tend")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/config")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/model")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/models")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/permissions read-only")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/plugins")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/usage session")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/review")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/fork Follow-up")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/undo")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/retry")).toBe(true);
    expect(isChatRunnerOwnedSlashCommand("/start goal-1")).toBe(false);
    expect(isChatRunnerOwnedSlashCommand("/settings")).toBe(false);
    expect(isChatRunnerOwnedSlashCommand("/dashboard")).toBe(false);
  });

  it("derives and clears displayed daemon goal from activeGoals", () => {
    expect(deriveDaemonGoalIdFromActiveGoals("goal-2", ["goal-1", "goal-2"])).toBe("goal-2");
    expect(deriveDaemonGoalIdFromActiveGoals("stale-goal", ["goal-1"])).toBe("goal-1");
    expect(deriveDaemonGoalIdFromActiveGoals("stale-goal", [])).toBeNull();
  });
});
