import { describe, expect, it } from "vitest";
import {
  USER_INPUT_SCHEMA_VERSION,
  createTextUserInput,
  getUserInputText,
  normalizeUserInput,
  replaceUserInputText,
  type UserInput,
} from "../user-input.js";

describe("UserInput contract", () => {
  it("preserves ordinary freeform text as a text item without semantic pre-classification", () => {
    const input = createTextUserInput("Can you look at the current repo?");

    expect(input).toEqual({
      schema_version: USER_INPUT_SCHEMA_VERSION,
      items: [{ kind: "text", text: "Can you look at the current repo?" }],
      rawText: "Can you look at the current repo?",
    });
    expect(input).not.toHaveProperty("intent");
    expect(input).not.toHaveProperty("route");
  });

  it("keeps multilingual paraphrases as equivalent text input shape", () => {
    const english = createTextUserInput("Please inspect the current workspace.");
    const japanese = createTextUserInput("今の作業フォルダを確認して");

    expect(english.items[0]?.kind).toBe("text");
    expect(japanese.items[0]?.kind).toBe("text");
    expect(Object.keys(english).sort()).toEqual(Object.keys(japanese).sort());
  });

  it("normalizes explicit structured items without deriving freeform intent", () => {
    const explicit: UserInput = {
      schema_version: USER_INPUT_SCHEMA_VERSION,
      rawText: "check this",
      items: [
        { kind: "text", text: "check this" },
        { kind: "mention", target: "session:conversation:abc", label: "current chat" },
        { kind: "local_image", path: "/tmp/screenshot.png", name: "screenshot" },
      ],
    };

    const normalized = normalizeUserInput(explicit, "fallback");

    expect(normalized.items).toEqual(explicit.items);
    expect(getUserInputText(normalized)).toBe("check this");
    expect(normalized).not.toHaveProperty("runtimeControlIntent");
  });

  it("redacts text items while preserving non-text structured items", () => {
    const input: UserInput = {
      schema_version: USER_INPUT_SCHEMA_VERSION,
      rawText: "token secret",
      items: [
        { kind: "text", text: "token secret" },
        { kind: "tool", name: "http_fetch", id: "tool-http-fetch" },
      ],
    };

    expect(replaceUserInputText(input, "token [redacted]")).toEqual({
      schema_version: USER_INPUT_SCHEMA_VERSION,
      rawText: "token [redacted]",
      items: [
        { kind: "text", text: "token [redacted]" },
        { kind: "tool", name: "http_fetch", id: "tool-http-fetch" },
      ],
    });
  });
});
