import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../../../base/state/state-manager.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { cmdPlaybook } from "../commands/playbook.js";
import { upsertDreamPlaybook } from "../../../platform/dream/playbook-memory.js";

describe("cmdPlaybook", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    tmpDir = makeTempDir("cli-playbook-");
    stateManager = new StateManager(tmpDir);
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      errors.push(String(message ?? ""));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("lists stored playbooks", async () => {
    const now = new Date().toISOString();
    await upsertDreamPlaybook(stateManager.getBaseDir(), {
      playbook_id: "dream-playbook-test",
      status: "promoted",
      kind: "verified_execution",
      title: "Repair provider config type boundary",
      summary: "Verified workflow",
      source_signature: "sig",
      applicability: {
        goal_ids: ["goal-1"],
        primary_dimensions: ["type_safety"],
        task_categories: ["verification"],
        terms: ["provider", "config"],
      },
      preconditions: [],
      recommended_steps: ["Patch the boundary"],
      verification_checks: [],
      failure_warnings: [],
      evidence_refs: [],
      source_task_ids: ["task-1"],
      verification: { verdict: "pass", confidence: 0.9, last_verified_at: now },
      usage: {
        retrieved_count: 0,
        verified_success_count: 1,
        successful_reuse_count: 1,
        failed_reuse_count: 0,
      },
      governance: {
        created_by: "dream",
        review_state: "verified",
        auto_generated: true,
        user_editable: true,
        auto_mutation: "forbidden",
      },
      created_at: now,
      updated_at: now,
    });

    const exitCode = await cmdPlaybook(["list"], stateManager);

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("dream-playbook-test");
    expect(logs.join("\n")).toContain("Repair provider config type boundary");
  });

  it("can disable a playbook", async () => {
    const now = new Date().toISOString();
    await upsertDreamPlaybook(stateManager.getBaseDir(), {
      playbook_id: "dream-playbook-disable",
      status: "promoted",
      kind: "verified_execution",
      title: "Disable me",
      summary: "Verified workflow",
      source_signature: "sig-disable",
      applicability: {
        goal_ids: ["goal-1"],
        primary_dimensions: ["type_safety"],
        task_categories: ["verification"],
        terms: ["disable"],
      },
      preconditions: [],
      recommended_steps: [],
      verification_checks: [],
      failure_warnings: [],
      evidence_refs: [],
      source_task_ids: ["task-1"],
      verification: { verdict: "pass", confidence: 0.9, last_verified_at: now },
      usage: {
        retrieved_count: 0,
        verified_success_count: 1,
        successful_reuse_count: 0,
        failed_reuse_count: 0,
      },
      governance: {
        created_by: "dream",
        review_state: "verified",
        auto_generated: true,
        user_editable: true,
        auto_mutation: "forbidden",
      },
      created_at: now,
      updated_at: now,
    });

    const exitCode = await cmdPlaybook(["disable", "dream-playbook-disable"], stateManager);

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("set to disabled");
    const showExitCode = await cmdPlaybook(["show", "dream-playbook-disable"], stateManager);
    expect(showExitCode).toBe(0);
    expect(logs.join("\n")).toContain("\"status\": \"disabled\"");
  });
});
