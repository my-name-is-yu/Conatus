import { describe, expect, it } from "vitest";
import { detectTurnLanguageHint, sameLanguageResponseInstruction } from "../turn-language.js";

describe("turn language hint", () => {
  it("detects Japanese from script without semantic phrase matching", () => {
    const hint = detectTurnLanguageHint("telegram繋げたい");

    expect(hint).toMatchObject({ language: "ja", source: "input_script" });
    expect(hint.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("detects English from Latin script", () => {
    const hint = detectTurnLanguageHint("I want to talk to Seedy from Telegram.");

    expect(hint).toMatchObject({ language: "en", source: "input_script" });
    expect(hint.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("keeps protocol tokens untranslated in the response instruction", () => {
    expect(sameLanguageResponseInstruction({ language: "ja", confidence: 0.9, source: "input_script" }))
      .toContain("Do not translate command names");
  });
});
