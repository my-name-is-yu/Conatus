import type { ZodSchema } from "zod";

// ─── Shared constant ───

export const DEFAULT_MAX_TOKENS = 4096;

// ─── JSON extraction utility ───

/**
 * Extract JSON from a string that may contain markdown code blocks.
 * Tries ```json ... ``` first, then ``` ... ```, then bare JSON.
 */
export function extractJSON(text: string): string {
  const jsonBlock = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonBlock) {
    return jsonBlock[1].trim();
  }
  const genericBlock = text.match(/```\s*([\s\S]*?)```/);
  if (genericBlock) {
    return genericBlock[1].trim();
  }
  return text.trim();
}

// ─── BaseLLMClient ───

/**
 * Abstract base for all LLM clients.
 * Provides a shared parseJSON() implementation with safeParse-based validation.
 */
export abstract class BaseLLMClient {
  /**
  * Extract JSON from LLM response text (handles markdown code blocks)
  * and validate against the given Zod schema.
  * Throws on parse failure or schema validation failure with detailed messages.
  */
  parseJSON<T>(content: string, schema: ZodSchema<T>): T {
    const jsonText = extractJSON(content);
    let raw: unknown;
    try {
      raw = JSON.parse(jsonText);
    } catch (err) {
      throw new Error(
        `LLM response JSON parse failed — ${String(err)}\nContent: ${content}`
      );
    }
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw new Error(
        `LLM response validation failed: ${result.error.issues.map((i) => i.message).join(", ")}. ` +
          `Raw: ${JSON.stringify(raw).slice(0, 200)}`
      );
    }
    return result.data;
  }
}
