import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigureNotificationRoutingTool } from "../ConfigureNotificationRoutingTool.js";
import type { ToolCallContext } from "../../../types.js";
import type { ILLMClient } from "../../../../base/llm/llm-client.js";

vi.mock("../../../../base/utils/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../base/utils/paths.js")>();
  return {
    ...actual,
    getPulseedDirPath: vi.fn(() => "/tmp/pulseed-routing-tool-placeholder"),
  };
});

import { getPulseedDirPath } from "../../../../base/utils/paths.js";

function makeContext(): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "goal-1",
    trustBalance: 50,
    preApproved: true,
    approvalFn: async () => true,
  };
}

function llmDecision(decision: unknown): Pick<ILLMClient, "sendMessage" | "parseJSON"> {
  return {
    sendMessage: async () => ({
      content: JSON.stringify(decision),
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: "stop",
    }),
    parseJSON: ((content: string, schema: { parse: (value: unknown) => unknown }) =>
      schema.parse(JSON.parse(content))) as Pick<ILLMClient, "sendMessage" | "parseJSON">["parseJSON"],
  };
}

describe("ConfigureNotificationRoutingTool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-routing-tool-"));
    vi.mocked(getPulseedDirPath).mockReturnValue(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes plugin notifier routing from a natural language instruction", async () => {
    const tool = new ConfigureNotificationRoutingTool({
      buildLLMClient: async () => llmDecision({
        action: "update_routes",
        selected_notifiers: ["discord-bot"],
        report_types: ["weekly_report"],
        mode: "only",
        enabled: true,
        confidence: 0.94,
        reason: "weekly report exclusive route",
      }),
    });

    const result = await tool.call(
      { instruction: "週次レポートはDiscordだけに送って" },
      makeContext()
    );

    expect(result.success).toBe(true);
    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "notification.json"), "utf-8")
    ) as Record<string, unknown>;
    expect(config["plugin_notifiers"]).toEqual({
      mode: "only",
      routes: [
        {
          id: "discord-bot",
          enabled: true,
          report_types: ["weekly_report"],
        },
      ],
    });
  });

  it("does not write plugin notifier routing when the parser returns ambiguous", async () => {
    const tool = new ConfigureNotificationRoutingTool({
      buildLLMClient: async () => llmDecision({
        action: "ambiguous",
        selected_notifiers: [],
        report_types: [],
        mode: null,
        enabled: null,
        confidence: 0.25,
        clarification: "Specify the notifier target.",
        reason: "missing notifier",
      }),
    });

    const result = await tool.call(
      { instruction: "通知いい感じにして" },
      makeContext()
    );

    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "notification.json"))).toBe(false);
  });

  it("requires approval when not pre-approved", async () => {
    const tool = new ConfigureNotificationRoutingTool();

    await expect(
      tool.checkPermissions({ instruction: "Discordだけ" }, { ...makeContext(), preApproved: false })
    ).resolves.toMatchObject({ status: "needs_approval" });
  });
});
