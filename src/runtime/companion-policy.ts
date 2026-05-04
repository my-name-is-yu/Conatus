import {
  CompanionCurrentTargetContextSchema,
  CompanionOutputPolicyDecisionSchema,
  CompanionPresenceStateSchema,
  CompanionRuntimeContractSchema,
  CompanionTurnPolicySchema,
  type CompanionCurrentTargetContext,
  type CompanionDialogueKind,
  type CompanionOutputPolicyDecision,
  type CompanionPresenceState,
  type CompanionQuietingDecision,
  type CompanionRuntimeContract,
  type CompanionTurnPolicy,
  type CompanionUrgency,
  type ConversationInputModality,
  type ConversationOutputMode,
} from "./types/companion.js";

export interface BuildCompanionContractInput {
  now?: string;
  sessionKey?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  runId?: string | null;
  goalId?: string | null;
  replyTargetId?: string | null;
  presence?: Partial<CompanionPresenceState>;
  turnPolicy?: Partial<CompanionTurnPolicy>;
  inputModality?: ConversationInputModality;
  outputMode?: ConversationOutputMode;
  dialogueKind?: CompanionDialogueKind;
  urgency?: CompanionUrgency;
}

function normalizeNullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function buildCompanionCurrentTargetContext(input: {
  sessionKey?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  runId?: string | null;
  goalId?: string | null;
  replyTargetId?: string | null;
}): CompanionCurrentTargetContext {
  return CompanionCurrentTargetContextSchema.parse({
    session_key: normalizeNullable(input.sessionKey),
    conversation_id: normalizeNullable(input.conversationId),
    message_id: normalizeNullable(input.messageId),
    run_id: normalizeNullable(input.runId),
    goal_id: normalizeNullable(input.goalId),
    reply_target_id: normalizeNullable(input.replyTargetId),
  });
}

export function buildCompanionRuntimeContract(input: BuildCompanionContractInput): CompanionRuntimeContract {
  const currentTarget = buildCompanionCurrentTargetContext(input);
  const now = input.now ?? new Date().toISOString();
  const presence = CompanionPresenceStateSchema.parse({
    schema_version: "companion-presence-state-v1",
    mode: input.presence?.mode ?? "available",
    interruptible: input.presence?.interruptible ?? true,
    last_user_activity_at: input.presence?.last_user_activity_at ?? now,
    current_context: input.presence?.current_context ?? "unknown",
    reason: input.presence?.reason,
    current_target: {
      ...input.presence?.current_target,
      ...currentTarget,
    },
  });
  const dialogueKind = input.turnPolicy?.dialogue_kind ?? input.dialogueKind ?? "direct_turn";
  const urgency = input.turnPolicy?.urgency ?? input.urgency ?? "normal";
  const outputMode = input.turnPolicy?.output_mode ?? input.outputMode ?? defaultOutputMode(dialogueKind);
  const quieting = input.turnPolicy?.quieting ?? decideQuieting({
    presence,
    dialogueKind,
    urgency,
    outputMode,
  });
  const canInterrupt = input.turnPolicy?.can_interrupt ?? (presence.interruptible || dialogueKind !== "interruption");
  const requiresExplicitInterruption =
    input.turnPolicy?.requires_explicit_interruption
    ?? (dialogueKind === "interruption" && !presence.interruptible);

  return CompanionRuntimeContractSchema.parse({
    schema_version: "companion-runtime-contract-v1",
    presence,
    turn_policy: {
      schema_version: "companion-turn-policy-v1",
      dialogue_kind: dialogueKind,
      input_modality: input.turnPolicy?.input_modality ?? input.inputModality ?? "text",
      output_mode: outputMode,
      can_interrupt: canInterrupt,
      latency_budget_ms: input.turnPolicy?.latency_budget_ms ?? defaultLatencyBudgetMs(outputMode),
      urgency,
      quieting,
      requires_explicit_interruption: requiresExplicitInterruption,
      current_target: {
        ...input.turnPolicy?.current_target,
        ...currentTarget,
      },
    },
  });
}

export function evaluateCompanionOutputPolicy(policy: CompanionTurnPolicy): CompanionOutputPolicyDecision {
  const parsed = CompanionTurnPolicySchema.parse(policy);
  if (parsed.requires_explicit_interruption && parsed.dialogue_kind === "interruption" && !parsed.can_interrupt) {
    return CompanionOutputPolicyDecisionSchema.parse({
      output_mode: "defer",
      quieting: parsed.quieting === "allow" ? "defer" : parsed.quieting,
      delivered: false,
      reason: "interruption_requires_explicit_request",
    });
  }
  if (parsed.quieting === "suppress") {
    return CompanionOutputPolicyDecisionSchema.parse({
      output_mode: "silent",
      quieting: "suppress",
      delivered: false,
      reason: "suppressed_by_quieting",
    });
  }
  if (parsed.quieting === "defer") {
    return CompanionOutputPolicyDecisionSchema.parse({
      output_mode: parsed.output_mode === "notification" ? "digest" : "defer",
      quieting: "defer",
      delivered: false,
      reason: "deferred_by_quieting",
    });
  }
  return CompanionOutputPolicyDecisionSchema.parse({
    output_mode: parsed.output_mode,
    quieting: "allow",
    delivered: true,
    reason: "allowed",
  });
}

function defaultOutputMode(dialogueKind: CompanionDialogueKind): ConversationOutputMode {
  switch (dialogueKind) {
    case "proactive":
    case "notification":
      return "notification";
    case "observation":
      return "silent";
    case "direct_turn":
    case "interruption":
      return "reply";
  }
}

function defaultLatencyBudgetMs(outputMode: ConversationOutputMode): number {
  switch (outputMode) {
    case "voice":
      return 1_500;
    case "reply":
      return 120_000;
    case "notification":
      return 30_000;
    case "digest":
    case "defer":
      return 300_000;
    case "silent":
      return 1_000;
  }
}

function decideQuieting(input: {
  presence: CompanionPresenceState;
  dialogueKind: CompanionDialogueKind;
  urgency: CompanionUrgency;
  outputMode: ConversationOutputMode;
}): CompanionQuietingDecision {
  if (input.presence.mode !== "do_not_disturb") {
    return "allow";
  }
  if (input.urgency === "critical") {
    return "allow";
  }
  if (input.dialogueKind === "proactive" || input.outputMode === "notification") {
    return input.urgency === "high" ? "defer" : "suppress";
  }
  return "defer";
}
