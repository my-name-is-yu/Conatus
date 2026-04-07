import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;

function getNotificationPath(): string {
  return path.join(tmpDir, "notification.json");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-notify-test-"));
  process.env["PULSEED_HOME"] = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  delete process.env["PULSEED_HOME"];
  await fsp.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
  vi.doUnmock("@clack/prompts");
});

async function loadStepWithMocks(selectValue: string, textValue?: string) {
  const select = vi.fn().mockResolvedValue(selectValue);
  const text = vi.fn().mockResolvedValue(textValue);
  const confirm = vi.fn().mockResolvedValue(true);

  vi.doMock("@clack/prompts", () => ({
    select,
    text,
    confirm,
    note: vi.fn(),
    cancel: vi.fn(),
    intro: vi.fn(),
    outro: vi.fn(),
    isCancel: vi.fn().mockReturnValue(false),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
  }));

  const mod = await import("../commands/setup/steps-notification.js");
  return { stepNotification: mod.stepNotification, select, text, confirm };
}

describe("stepNotification", () => {
  it("is importable", async () => {
    const { stepNotification } = await loadStepWithMocks("console");
    expect(stepNotification).toBeTypeOf("function");
  });

  it("writes console-only config", async () => {
    const { stepNotification, text } = await loadStepWithMocks("console");
    await expect(stepNotification()).resolves.toEqual({ channels: [] });
    expect(text).not.toHaveBeenCalled();
    await expect(fsp.readFile(getNotificationPath(), "utf-8")).resolves.toContain('"channels": []');
  });

  it("writes slack webhook config", async () => {
    const { stepNotification, text } = await loadStepWithMocks("slack", "https://hooks.slack.com/services/T/B/X");
    await expect(stepNotification()).resolves.toEqual({
      channels: [{ type: "slack", webhook_url: "https://hooks.slack.com/services/T/B/X", report_types: [], format: "compact" }],
    });
    expect(text).toHaveBeenCalledOnce();
    await expect(fsp.readFile(getNotificationPath(), "utf-8")).resolves.toContain('"type": "slack"');
  });

  it("writes generic webhook config", async () => {
    const { stepNotification, text } = await loadStepWithMocks("webhook", "https://example.com/pulseed");
    await expect(stepNotification()).resolves.toEqual({
      channels: [{ type: "webhook", url: "https://example.com/pulseed", report_types: [], format: "json" }],
    });
    expect(text).toHaveBeenCalledOnce();
    await expect(fsp.readFile(getNotificationPath(), "utf-8")).resolves.toContain('"url": "https://example.com/pulseed"');
  });

  it("returns null and skips file creation", async () => {
    const { stepNotification, confirm } = await loadStepWithMocks("skip");
    await expect(stepNotification()).resolves.toBeNull();
    expect(confirm).toHaveBeenCalledOnce();
    await expect(fsp.access(getNotificationPath())).rejects.toBeDefined();
  });
});
