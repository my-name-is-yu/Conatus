import type { ToolActivityCategory } from "../../../tools/types.js";
import type { AgentLoopCommandEvidenceSource, AgentLoopCommandResultCategory } from "./agent-loop-result.js";

export interface AgentLoopVerificationPlan {
  /**
   * Exact commands declared by the task or caller as verification evidence.
   * This is a typed caller contract, not a command-text semantic classifier.
   */
  requiredCommands?: readonly string[];
}

export function classifyAgentLoopCommandResult(input: {
  toolName: string;
  command: string;
  activityCategory?: ToolActivityCategory;
  verificationPlan?: AgentLoopVerificationPlan;
}): {
  category: AgentLoopCommandResultCategory;
  evidenceEligible: boolean;
  evidenceSource?: AgentLoopCommandEvidenceSource;
} {
  const command = input.command.trim();
  const verificationCommands = new Set(
    (input.verificationPlan?.requiredCommands ?? [])
      .map((item) => item.trim())
      .filter(Boolean),
  );

  if (verificationCommands.has(command)) {
    return {
      category: "verification",
      evidenceEligible: true,
      evidenceSource: "verification_plan",
    };
  }

  if (input.activityCategory === "test") {
    return {
      category: "verification",
      evidenceEligible: true,
      evidenceSource: "tool_activity_category",
    };
  }

  if (input.activityCategory === "search" || input.activityCategory === "read" || input.activityCategory === "planning") {
    return { category: "observation", evidenceEligible: false };
  }

  return { category: "other", evidenceEligible: false };
}
