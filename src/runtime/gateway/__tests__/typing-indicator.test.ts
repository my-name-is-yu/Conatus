import { describe, expect, it, vi } from "vitest";
import type { TypingIndicatorCapability } from "../channel-adapter.js";
import {
  createUnsupportedTypingIndicator,
  withTypingIndicator,
} from "../typing-indicator.js";

describe("typing indicator capability", () => {
  it("reports unsupported no-op capability explicitly", async () => {
    const capability = createUnsupportedTypingIndicator("not available");
    const session = await capability.start({
      platform: "signal",
      conversation_id: "conversation-1",
    });

    expect(capability.status).toBe("unsupported");
    expect(capability.reason).toBe("not available");
    expect(session.status).toBe("unsupported");
    await expect(session.stop()).resolves.toBeUndefined();
  });

  it("does not fail the chat turn when typing start fails", async () => {
    const capability: TypingIndicatorCapability = {
      status: "native",
      start: vi.fn().mockRejectedValue(new Error("typing unavailable")),
    };
    const turn = vi.fn().mockResolvedValue("reply");

    await expect(withTypingIndicator(capability, {
      platform: "telegram",
      conversation_id: "314",
    }, turn)).resolves.toBe("reply");

    expect(turn).toHaveBeenCalledOnce();
  });

  it("stops the indicator when the chat turn fails", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const capability: TypingIndicatorCapability = {
      status: "native",
      start: vi.fn().mockResolvedValue({ status: "native", stop }),
    };

    await expect(withTypingIndicator(capability, {
      platform: "discord",
      conversation_id: "channel-1",
    }, async () => {
      throw new Error("turn failed");
    })).rejects.toThrow("turn failed");

    expect(stop).toHaveBeenCalledOnce();
  });
});
