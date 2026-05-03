import { z } from "zod";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import { getInternalIdentityPrefix } from "../../base/config/identity-loader.js";

export const FreeformRouteIntentSchema = z.object({
  kind: z.enum(["assist", "configure", "execute", "clarify"]),
  confidence: z.number().min(0).max(1),
  configure_target: z.enum(["telegram_gateway", "gateway", "provider", "daemon", "notification", "slack", "unknown"]).optional(),
  rationale: z.string().max(240),
});

export type FreeformRouteIntent = z.infer<typeof FreeformRouteIntentSchema>;

export async function classifyFreeformRouteIntent(
  input: string,
  llmClient: ILLMClient | undefined,
): Promise<FreeformRouteIntent | null> {
  if (!llmClient) return null;
  try {
    const response = await llmClient.sendMessage(
      [{ role: "user", content: input }],
      { system: getFreeformRoutePrompt(), max_tokens: 500, temperature: 0 },
    );
    const parsed = llmClient.parseJSON(response.content, FreeformRouteIntentSchema);
    return parsed instanceof Promise ? await parsed : parsed;
  } catch {
    return null;
  }
}

function getFreeformRoutePrompt(): string {
  return `${getInternalIdentityPrefix("assistant")} Route the operator's freeform chat message before any coding agent execution.

Return only JSON:
{
  "kind": "assist" | "configure" | "execute" | "clarify",
  "confidence": 0.0-1.0,
  "configure_target": "telegram_gateway" | "gateway" | "provider" | "daemon" | "notification" | "slack" | "unknown",
  "rationale": "short"
}

Routing contract:
- assist: questions, how-to, status explanation, read-only guidance.
- configure: setup/configuration of Telegram, Slack, daemon, provider, notifications, gateway, or channels.
- execute: concrete repo edits, tests, implementation, commands, or goal execution that should enter the coding agent loop.
- clarify: ambiguous or underspecified input where executing code would be unsafe.

Use semantic intent, not literal phrase matching. Multilingual paraphrases should route by meaning.
If the user wants to connect Seedy/PulSeed to a chat channel, configure the relevant gateway rather than execute source edits.
If confidence is below 0.7, use clarify.`;
}
