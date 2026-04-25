import { describe, expect, it, vi } from "vitest";
import { attachMouseTracking, isMouseTrackingEnabled } from "../flicker/MouseTracking.js";
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING } from "../flicker/dec.js";

function createMockStream(): NodeJS.WriteStream & { _written: string[] } {
  const written: string[] = [];
  return {
    write: vi.fn((chunk: string) => {
      written.push(chunk);
      return true;
    }),
    _written: written,
  } as unknown as NodeJS.WriteStream & { _written: string[] };
}

describe("mouse tracking", () => {
  it("leaves mouse tracking disabled by default so terminal text selection works", () => {
    const original = process.env.PULSEED_MOUSE_TRACKING;
    delete process.env.PULSEED_MOUSE_TRACKING;

    try {
      expect(isMouseTrackingEnabled()).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.PULSEED_MOUSE_TRACKING;
      } else {
        process.env.PULSEED_MOUSE_TRACKING = original;
      }
    }
  });

  it("allows mouse tracking to be explicitly enabled", () => {
    const original = process.env.PULSEED_MOUSE_TRACKING;
    process.env.PULSEED_MOUSE_TRACKING = "1";

    try {
      expect(isMouseTrackingEnabled()).toBe(true);
    } finally {
      if (original === undefined) {
        delete process.env.PULSEED_MOUSE_TRACKING;
      } else {
        process.env.PULSEED_MOUSE_TRACKING = original;
      }
    }
  });

  it("enables mouse tracking on attach and disables it on cleanup", () => {
    const stream = createMockStream();

    const cleanup = attachMouseTracking(stream);

    expect(stream.write).toHaveBeenCalledWith(ENABLE_MOUSE_TRACKING);
    expect(stream._written).toContain(ENABLE_MOUSE_TRACKING);

    cleanup();

    expect(stream._written.at(-1)).toBe(DISABLE_MOUSE_TRACKING);
  });
});
