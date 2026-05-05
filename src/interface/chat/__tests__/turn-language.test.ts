import { describe, expect, it } from "vitest";
import { detectTurnLanguageHint, sameLanguageResponseInstruction } from "../turn-language.js";

describe("turn language hint", () => {
  it("detects Japanese from script without semantic phrase matching", () => {
    const hint = detectTurnLanguageHint("telegram繋げたい");

    expect(hint).toMatchObject({ language: "ja", source: "input_script" });
    expect(hint.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("detects Latin script without treating it as English", () => {
    const hint = detectTurnLanguageHint("I want to talk to Seedy from Telegram.");

    expect(hint).toMatchObject({ language: "unknown", script: "latin", source: "input_script" });
    expect(hint.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("keeps protocol tokens untranslated in the response instruction", () => {
    expect(sameLanguageResponseInstruction({ language: "ja", confidence: 0.9, source: "input_script" }))
      .toContain("Do not translate command names");
  });

  it("ignores setup secret redaction markers when detecting the user's language", () => {
    const hint = detectTurnLanguageHint("このtokenで進めて [REDACTED:telegram_bot_token:setup_secret_1]");

    expect(hint).toMatchObject({ language: "ja", source: "input_script" });
  });
});
