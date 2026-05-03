import { z } from "zod";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { RuntimeControlOperationKind } from "../store/runtime-operation-schemas.js";

export interface RuntimeControlIntent {
  kind: RuntimeControlOperationKind;
  reason: string;
  target?: RuntimeControlTargetHint;
  externalActions?: string[];
  irreversible?: boolean;
}

export interface RuntimeControlTargetHint {
  runId?: string;
  sessionId?: string;
}

const RuntimeControlIntentDecisionSchema = z.object({
  intent: z.enum([
    "none",
    "inspect_run",
    "pause_run",
    "resume_run",
    "finalize_run",
    "restart_daemon",
    "restart_gateway",
  ]),
  reason: z.string().min(1).optional(),
  target: z.object({
    runId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
  }).optional(),
  externalActions: z.array(z.enum([
    "submit",
    "publish",
    "secret",
    "production_mutation",
    "destructive_cleanup",
  ])).optional(),
  irreversible: z.boolean().optional(),
});

type RuntimeControlIntentDecision = z.infer<typeof RuntimeControlIntentDecisionSchema>;

function buildRuntimeControlIntentSystemPrompt(): string {
  return `You classify one operator chat message for PulSeed runtime control routing.

Decide whether the user's primary intent is to operate on an existing active or recent long-running runtime session, or on the PulSeed daemon/gateway itself.

Return only JSON matching:
{
  "intent": "none" | "inspect_run" | "pause_run" | "resume_run" | "finalize_run" | "restart_daemon" | "restart_gateway",
  "reason": "short reason using the user's words",
  "target": { "runId": "optional exact run id", "sessionId": "optional exact session id" },
  "externalActions": ["submit" | "publish" | "secret" | "production_mutation" | "destructive_cleanup"],
  "irreversible": true | false
}

Classification rules:
- Choose inspect_run, pause_run, resume_run, or finalize_run only when the user is asking to inspect/control/finalize an existing runtime run/session/execution.
- Choose none for ordinary project work, coding requests, implementation continuation, evidence/progress Q&A, status questions, explanations, help, or requests to create/start new work.
- Choose none for broad follow-ups like "continue", "finish the implementation", or "続けて" unless the message itself clearly refers to resuming/finalizing a runtime run/session/execution.
- Choose finalize_run for closing/finalizing a run. Mark irreversible true.
- If finalize would involve external submit/publish, secrets, production mutation, or destructive cleanup, include the matching externalActions. Do not assume these actions should execute.
- If the user names a run id or session id, copy it exactly into target. Otherwise omit target.
- Use restart_daemon/restart_gateway only when the user is asking to restart the PulSeed daemon or gateway, not for run/session pause/resume/finalize.
- When uncertain, choose none.`;
}

export async function recognizeRuntimeControlIntent(
  input: string,
  llmClient?: Pick<ILLMClient, "sendMessage" | "parseJSON">
): Promise<RuntimeControlIntent | null> {
  const trimmed = input.trim();
  if (!trimmed || !llmClient) return null;

  const response = await llmClient.sendMessage(
    [{ role: "user", content: trimmed }],
    {
      system: buildRuntimeControlIntentSystemPrompt(),
      max_tokens: 512,
      temperature: 0,
      model_tier: "light",
    }
  );
  try {
    const decision = llmClient.parseJSON(response.content, RuntimeControlIntentDecisionSchema);
    return toRuntimeControlIntent(trimmed, decision);
  } catch {
    return null;
  }
}

function toRuntimeControlIntent(
  input: string,
  decision: RuntimeControlIntentDecision
): RuntimeControlIntent | null {
  if (decision.intent === "none") return null;
  const target = normalizeTarget(decision.target);
  return {
    kind: decision.intent,
    reason: decision.reason?.trim() || input,
    ...(target ? { target } : {}),
    ...(decision.externalActions && decision.externalActions.length > 0
      ? { externalActions: [...new Set(decision.externalActions)] }
      : {}),
    ...(decision.intent === "finalize_run" || decision.irreversible
      ? { irreversible: true }
      : {}),
  };
}

function normalizeTarget(target: RuntimeControlIntentDecision["target"]): RuntimeControlTargetHint | null {
  const runId = target?.runId?.trim();
  const sessionId = target?.sessionId?.trim();
  if (!runId && !sessionId) return null;
  return {
    ...(runId ? { runId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
}
