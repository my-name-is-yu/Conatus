import { z } from "zod";

export const TurnLanguageHintSchema = z.object({
  language: z.enum(["en", "ja", "unknown"]),
  confidence: z.number().min(0).max(1),
  source: z.enum(["input_script", "caller", "unknown"]),
});

export type TurnLanguageHint = z.infer<typeof TurnLanguageHintSchema>;

export const UNKNOWN_TURN_LANGUAGE_HINT: TurnLanguageHint = {
  language: "unknown",
  confidence: 0,
  source: "unknown",
};

export function detectTurnLanguageHint(input: string): TurnLanguageHint {
  const languageText = input.replace(/\[REDACTED:[^\]]+\]/g, " ");
  const letters = Array.from(languageText).filter((char) => /\p{Letter}/u.test(char));
  if (letters.length === 0) return UNKNOWN_TURN_LANGUAGE_HINT;

  const japanese = letters.filter((char) => /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(char)).length;
  const latin = letters.filter((char) => /\p{Script=Latin}/u.test(char)).length;
  const total = letters.length;

  if (japanese > 0 && japanese / total >= 0.25) {
    return { language: "ja", confidence: Math.min(0.99, Math.max(0.75, japanese / total)), source: "input_script" };
  }
  if (latin > 0 && latin / total >= 0.6) {
    return { language: "en", confidence: Math.min(0.95, Math.max(0.7, latin / total)), source: "input_script" };
  }
  return UNKNOWN_TURN_LANGUAGE_HINT;
}

export function shouldRenderJapanese(hint: TurnLanguageHint | null | undefined): boolean {
  return hint?.language === "ja" && hint.confidence >= 0.5;
}

export function sameLanguageResponseInstruction(hint: TurnLanguageHint | null | undefined): string {
  const base = "Reply in the same language as the user's current input. Do not translate command names, slash commands, file paths, config keys, environment variables, protocol tokens, or code.";
  if (hint?.language === "ja") {
    return `${base} The current turn language hint is Japanese, so user-facing prose should be Japanese.`;
  }
  if (hint?.language === "en") {
    return `${base} The current turn language hint is English, so user-facing prose should be English.`;
  }
  return base;
}
