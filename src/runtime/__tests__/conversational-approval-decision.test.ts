import { describe, expect, it } from "vitest";
import { classifyConversationalApprovalDecision } from "../conversational-approval-decision.js";
import type { ApprovalRecord } from "../store/runtime-schemas.js";
import { createSingleMockLLMClient } from "../../../tests/helpers/mock-llm.js";

const approval: ApprovalRecord = {
  approval_id: "approval-1",
  goal_id: "goal-1",
  request_envelope_id: "approval-1",
  correlation_id: "approval-1",
  state: "pending",
  created_at: 10,
  expires_at: 10_000,
  origin: {
    channel: "slack",
    conversation_id: "thread-1",
    user_id: "user-1",
    session_id: "session-1",
    turn_id: "turn-1",
  },
  payload: {
    task: {
      id: "production-deploy",
      description: "Deploy production changes",
      action: "deploy",
    },
  },
};

describe("classifyConversationalApprovalDecision", () => {
  it("accepts exact protocol approve and reject commands without model classification", async () => {
    await expect(classifyConversationalApprovalDecision("/approve", {
      approval,
      replyOrigin: approval.origin!,
    })).resolves.toMatchObject({ decision: "approve", confidence: 1 });
    await expect(classifyConversationalApprovalDecision("/reject", {
      approval,
      replyOrigin: approval.origin!,
    })).resolves.toMatchObject({ decision: "reject", confidence: 1 });
  });

  it("classifies paraphrased multilingual approval replies through the shared contract", async () => {
    const decision = await classifyConversationalApprovalDecision("問題ありません。進めてください", {
      approval,
      replyOrigin: approval.origin!,
      llmClient: createSingleMockLLMClient(JSON.stringify({
        decision: "approve",
        confidence: 0.93,
        rationale: "Explicit approval for the active deployment request.",
      })),
    });

    expect(decision).toMatchObject({ decision: "approve", confidence: 0.93 });
  });

  it("classifies paraphrased denial replies through the shared contract", async () => {
    const decision = await classifyConversationalApprovalDecision("やっぱり実行しないでください", {
      approval,
      replyOrigin: approval.origin!,
      llmClient: createSingleMockLLMClient(JSON.stringify({
        decision: "reject",
        confidence: 0.94,
        rationale: "Explicit rejection for the active request.",
      })),
    });

    expect(decision).toMatchObject({ decision: "reject", confidence: 0.94 });
  });

  it("keeps clarification separate from approval or rejection", async () => {
    const decision = await classifyConversationalApprovalDecision("Before deciding, what target will change?", {
      approval,
      replyOrigin: approval.origin!,
      llmClient: createSingleMockLLMClient(JSON.stringify({
        decision: "clarify",
        confidence: 0.91,
        clarification: "The approval is still pending while the target is clarified.",
      })),
    });

    expect(decision).toMatchObject({
      decision: "clarify",
      clarification: "The approval is still pending while the target is clarified.",
    });
  });

  it("downgrades low-confidence replies to unknown", async () => {
    const decision = await classifyConversationalApprovalDecision("sounds fine I guess", {
      approval,
      replyOrigin: approval.origin!,
      llmClient: createSingleMockLLMClient(JSON.stringify({
        decision: "approve",
        confidence: 0.42,
        clarification: "Please explicitly approve or reject the active request.",
      })),
    });

    expect(decision).toMatchObject({
      decision: "unknown",
      confidence: 0,
      clarification: "Please explicitly approve or reject the active request.",
    });
  });

  it("keeps unrelated new intents separate from approval or rejection", async () => {
    const decision = await classifyConversationalApprovalDecision("Actually summarize yesterday's logs first.", {
      approval,
      replyOrigin: approval.origin!,
      llmClient: createSingleMockLLMClient(JSON.stringify({
        decision: "new_intent",
        confidence: 0.91,
        rationale: "The reply asks for a separate task.",
      })),
    });

    expect(decision).toMatchObject({ decision: "new_intent", confidence: 0.91 });
  });
});
