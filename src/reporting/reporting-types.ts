import type { VerificationFileDiff } from "../base/types/task.js";
import type { DeadlineFinalizationStatus } from "../platform/time/deadline-finalization.js";

export type ExecutionSummaryWaitStatus = {
  strategyId?: string;
  status: string;
  details?: string;
  approvalId?: string;
  observeOnly?: boolean;
  suppressed?: boolean;
  expired?: boolean;
  skipReason?: string;
};

export type ExecutionSummaryParams = {
  goalId: string;
  loopIndex: number;
  observation: { dimensionName: string; progress: number; confidence: number }[];
  gapAggregate: number;
  taskResult: {
    taskId: string;
    action: string;
    dimension: string;
    verificationDiffs?: VerificationFileDiff[];
  } | null;
  stallDetected: boolean;
  pivotOccurred: boolean;
  elapsedMs: number;
  waitStatus?: ExecutionSummaryWaitStatus;
  finalizationStatus?: DeadlineFinalizationStatus;
};

export type NotificationType =
  | "urgent"
  | "approval_required"
  | "stall_escalation"
  | "completed"
  | "capability_insufficient";

export type NotificationContext = {
  goalId: string;
  message: string;
  details?: string;
};
