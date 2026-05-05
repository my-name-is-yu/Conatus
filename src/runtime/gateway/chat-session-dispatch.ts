import {
  getRegisteredGatewayChatSessionPort,
  type GatewayChatDispatchInput,
} from "./chat-session-port.js";

export type { GatewayChatDispatchInput } from "./chat-session-port.js";

export async function dispatchGatewayChatInput(
  input: GatewayChatDispatchInput
): Promise<string | null> {
  try {
    const portGetter = getRegisteredGatewayChatSessionPort();
    if (!portGetter) return null;
    const port = await portGetter();
    const result = await port.processIncomingMessage({
      text: input.text,
      platform: input.platform,
      identity_key: input.identity_key,
      conversation_id: input.conversation_id,
      sender_id: input.sender_id,
      message_id: input.message_id,
      goal_id: input.goal_id,
      cwd: input.cwd,
      metadata: input.metadata,
      onEvent: input.onEvent,
    });
    return normalizeManagerResult(result);
  } catch {
    return null;
  }
}

function normalizeManagerResult(result: unknown): string | null {
  if (typeof result === "string") {
    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    for (const key of ["text", "message"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
  }
  return null;
}
