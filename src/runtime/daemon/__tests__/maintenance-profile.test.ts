import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DaemonConfigSchema, DaemonStateSchema } from "../../types/daemon.js";
import { upsertRelationshipProfileItem } from "../../../platform/profile/relationship-profile.js";
import { runProactiveMaintenance } from "../maintenance.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-proactive-profile-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runProactiveMaintenance relationship profile context", () => {
  it("uses only active resident-behavior profile items", async () => {
    const baseDir = makeTempDir();
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.intervention.nudge",
      kind: "intervention_policy",
      value: "Suggest only when the next action is clearly reversible.",
      source: "cli_update",
      allowedScopes: ["resident_behavior"],
      now: "2026-05-02T00:00:00.000Z",
    });
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.preference.planning",
      kind: "preference",
      value: "Use detailed weekly planning notes.",
      source: "cli_update",
      allowedScopes: ["local_planning"],
      now: "2026-05-02T00:00:00.000Z",
    });

    const sendMessage = vi.fn().mockResolvedValue({ content: JSON.stringify({ action: "sleep", details: {} }) });
    const llmClient = {
      sendMessage,
      parseJSON: vi.fn().mockImplementation((content: string, schema: { parse(value: unknown): unknown }) =>
        schema.parse(JSON.parse(content))
      ),
    };

    await runProactiveMaintenance({
      config: DaemonConfigSchema.parse({
        proactive_mode: true,
        proactive_interval_ms: 1,
        runtime_root: baseDir,
      }),
      llmClient: llmClient as never,
      state: DaemonStateSchema.parse({
        pid: 123,
        started_at: "2026-05-02T00:00:00.000Z",
        last_loop_at: null,
        loop_count: 0,
        active_goals: [],
        status: "idle",
      }),
      lastProactiveTickAt: 0,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    const prompt = sendMessage.mock.calls[0]?.[0]?.[0]?.content ?? "";
    expect(prompt).toContain("Suggest only when the next action is clearly reversible.");
    expect(prompt).not.toContain("Use detailed weekly planning notes.");
  });
});
