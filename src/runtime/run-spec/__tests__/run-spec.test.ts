import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveRunSpecFromText, recognizeRunSpecIntent } from "../derive.js";
import { createRunSpecStore } from "../store.js";

const NOW = new Date("2026-05-02T00:00:00.000Z");

describe("RunSpec derivation", () => {
  it("derives a Kaggle RunSpec with separate metric and progress semantics", () => {
    const spec = deriveRunSpecFromText(
      "Run this Kaggle competition until tomorrow morning and aim for top 15%. Keep submissions approval-gated.",
      {
        cwd: "/work/kaggle/playground",
        now: NOW,
        timezone: "Asia/Tokyo",
      },
    );

    expect(spec).not.toBeNull();
    expect(spec!.profile).toBe("kaggle");
    expect(spec!.workspace).toMatchObject({ path: "/work/kaggle/playground", source: "context" });
    expect(spec!.metric).toMatchObject({
      name: "leaderboard_rank_percentile",
      direction: "minimize",
      target_rank_percent: 15,
    });
    expect(spec!.progress_contract).toMatchObject({
      kind: "rank_percentile",
      threshold: 15,
    });
    expect(spec!.deadline).toMatchObject({
      raw: "tomorrow morning",
      finalization_buffer_minutes: 60,
    });
    expect(spec!.approval_policy.submit).toBe("approval_required");
    expect(spec!.risk_flags).toContain("external_submit_requires_approval");
    expect(spec!.missing_fields).toEqual([]);
  });

  it("derives a generic long-running RunSpec", () => {
    const spec = deriveRunSpecFromText(
      "Keep this background optimization running until tomorrow morning and maximize accuracy 0.91.",
      {
        cwd: "/repo/app",
        now: NOW,
      },
    );

    expect(spec).not.toBeNull();
    expect(spec!.profile).toBe("generic");
    expect(spec!.metric).toMatchObject({
      name: "accuracy",
      direction: "maximize",
      target: 0.91,
    });
    expect(spec!.progress_contract).toMatchObject({
      kind: "metric_target",
      dimension: "accuracy",
      threshold: 0.91,
    });
  });

  it("preserves ambiguous metric direction as a required missing field", () => {
    const spec = deriveRunSpecFromText(
      "Run this long-running task until tomorrow morning and reach score 0.98.",
      {
        cwd: "/repo/app",
        now: NOW,
      },
    );

    expect(spec).not.toBeNull();
    expect(spec!.metric).toMatchObject({
      name: "score",
      direction: "unknown",
      target: 0.98,
    });
    expect(spec!.progress_contract).toMatchObject({
      kind: "metric_target",
      threshold: 0.98,
    });
    expect(spec!.missing_fields).toContainEqual({
      field: "metric.direction",
      question: "Should score be maximized or minimized?",
      severity: "required",
    });
  });

  it("does not guess missing workspace and deadline", () => {
    const spec = deriveRunSpecFromText("Run a long-running Kaggle experiment for top 20%.", {
      now: NOW,
    });

    expect(spec).not.toBeNull();
    expect(spec!.workspace).toBeNull();
    expect(spec!.deadline).toBeNull();
    expect(spec!.missing_fields.map((field) => field.field)).toEqual(["workspace", "deadline"]);
  });

  it("does not treat explanatory long-running questions as run requests", () => {
    expect(recognizeRunSpecIntent("Why do long-running tasks fail?")).toBeNull();
  });
});

describe("RunSpecStore", () => {
  it("persists and reloads a RunSpec under the state root", async () => {
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-runspec-"));
    const spec = deriveRunSpecFromText("Run Kaggle until tomorrow morning and aim for top 15%.", {
      cwd: "/repo/kaggle",
      now: NOW,
    });
    expect(spec).not.toBeNull();

    const store = createRunSpecStore({ getBaseDir: () => baseDir });
    await store.save(spec!);

    await expect(store.load(spec!.id)).resolves.toMatchObject({
      id: spec!.id,
      profile: "kaggle",
      schema_version: "run-spec-v1",
    });
  });

  it("rejects path-like ids before RunSpec store file I/O", async () => {
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-runspec-"));
    const spec = deriveRunSpecFromText("Run Kaggle until tomorrow morning and aim for top 15%.", {
      cwd: "/repo/kaggle",
      now: NOW,
    });
    expect(spec).not.toBeNull();
    const store = createRunSpecStore({ getBaseDir: () => baseDir });

    await expect(store.save({ ...spec!, id: "../sessions/foo" })).rejects.toThrow();
    await expect(store.load("../sessions/foo")).rejects.toThrow();
  });
});
