import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "child_process";
import { copyToClipboard } from "../clipboard.js";
import { setTrustedTuiControlStream } from "../terminal-output.js";

function makeFakeProc(exitCode: number) {
  const proc = new EventEmitter() as any;
  proc.stdin = { end: vi.fn() };
  setTimeout(() => proc.emit("close", exitCode), 0);
  return proc;
}

describe("copyToClipboard", () => {
  const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
  const originalPlatform = process.platform;

  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    setTrustedTuiControlStream(null);
  });

  it("macOS: calls pbcopy and returns true on success", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    spawnMock.mockReturnValue(makeFakeProc(0));

    const result = await copyToClipboard("hello");

    expect(result).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith("pbcopy", [], expect.any(Object));
  });

  it("Linux: calls xclip and returns true on success", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    spawnMock.mockReturnValue(makeFakeProc(0));

    const result = await copyToClipboard("hello");

    expect(result).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith("xclip", ["-selection", "clipboard"], expect.any(Object));
  });

  it("Linux: falls back to xsel when xclip fails", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    spawnMock
      .mockReturnValueOnce(makeFakeProc(1))
      .mockReturnValueOnce(makeFakeProc(0));

    const result = await copyToClipboard("hello");

    expect(result).toBe(true);
    expect(spawnMock).toHaveBeenNthCalledWith(2, "xsel", ["--clipboard", "--input"], expect.any(Object));
  });

  it("Linux: falls back to OSC52 when xclip and xsel fail", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    spawnMock
      .mockReturnValueOnce(makeFakeProc(1))
      .mockReturnValueOnce(makeFakeProc(1));
    const write = vi.fn(() => true);
    setTrustedTuiControlStream({ write } as any);

    const result = await copyToClipboard("hello");

    expect(result).toBe(true);
    expect(write).toHaveBeenCalledWith("\u001b]52;c;aGVsbG8=\u0007");
  });

  it("always returns a boolean", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    spawnMock.mockReturnValue(makeFakeProc(0));

    const result = await copyToClipboard("test");
    expect(typeof result).toBe("boolean");
  });

  it("fallback: writes a complete OSC52 clipboard sequence", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const write = vi.fn(() => true);
    setTrustedTuiControlStream({ write } as any);

    const result = await copyToClipboard("hello");

    expect(result).toBe(true);
    expect(write).toHaveBeenCalledWith("\u001b]52;c;aGVsbG8=\u0007");
  });
});
