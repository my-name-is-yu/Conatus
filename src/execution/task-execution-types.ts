import type { Task, VerificationResult } from "../types/task.js";
import type { CapabilityAcquisitionTask } from "../types/capability.js";

/**
 * Result produced by one full task cycle (generate → approve → execute → verify).
 * Defined here (not in task-lifecycle.ts) to break the circular dependency between
 * task-lifecycle.ts and task-approval.ts.
 */
export interface TaskCycleResult {
  task: Task;
  verificationResult: VerificationResult;
  action: "completed" | "keep" | "discard" | "escalate" | "approval_denied" | "capability_acquiring";
  acquisition_task?: CapabilityAcquisitionTask;
}
