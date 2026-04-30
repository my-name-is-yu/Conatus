/**
 * loop-report-helper.ts
 *
 * Helper to generate and save a per-iteration execution report inside CoreLoop.
 */

import type { Goal } from "../../base/types/goal.js";
import type { ExecutionSummaryParams, ReportingEngine, LoopIterationResult } from "./core-loop/contracts.js";
import type { Logger } from "../../runtime/logger.js";
import { dimensionProgress } from "../../platform/drive/gap-calculator.js";

/**
 * Generate and save an execution summary report for one iteration.
 * Non-fatal: report generation failures are logged and swallowed.
 */
export async function generateLoopReport(
  goalId: string,
  loopIndex: number,
  iterationResult: LoopIterationResult,
  goal: Goal,
  reportingEngine: ReportingEngine,
  logger: Logger | undefined
): Promise<void> {
  try {
    const observation = goal.dimensions.map((d) => {
      const prog = dimensionProgress(d.current_value, d.threshold);
      let progress: number;
      if (prog !== null) {
        progress = prog;
      } else if (typeof d.current_value === "number") {
        progress = d.current_value;
      } else {
        progress = 0;
      }
      return {
        dimensionName: d.name,
        progress,
        confidence: d.confidence,
      };
    });

    const taskResult =
      iterationResult.taskResult !== null
        ? {
            taskId: iterationResult.taskResult.task.id,
            action: iterationResult.taskResult.action,
            dimension: iterationResult.taskResult.task.primary_dimension,
            verificationDiffs: iterationResult.taskResult.verificationResult.file_diffs,
          }
        : null;
    const waitStatus = buildWaitStatus(iterationResult);

    const report = reportingEngine.generateExecutionSummary({
      goalId,
      loopIndex,
      observation,
      gapAggregate: iterationResult.gapAggregate,
      taskResult,
      stallDetected: iterationResult.stallDetected,
      pivotOccurred: iterationResult.pivotOccurred,
      elapsedMs: iterationResult.elapsedMs,
      ...(waitStatus ? { waitStatus } : {}),
      ...(iterationResult.finalizationStatus && iterationResult.finalizationStatus.mode !== "no_deadline"
        ? { finalizationStatus: iterationResult.finalizationStatus }
        : {}),
    });
    await reportingEngine.saveReport(report);
  } catch (err) {
    logger?.warn("CoreLoop: report generation failed", {
      goalId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function buildWaitStatus(
  iterationResult: LoopIterationResult
): ExecutionSummaryParams["waitStatus"] | undefined {
  if (
    !iterationResult.waitExpiryOutcome
    && iterationResult.waitSuppressed !== true
    && iterationResult.waitExpired !== true
    && iterationResult.waitObserveOnly !== true
    && !iterationResult.waitStrategyId
  ) {
    return undefined;
  }

  return {
    strategyId: iterationResult.waitStrategyId,
    status:
      iterationResult.waitExpiryOutcome?.status
      ?? (iterationResult.waitSuppressed ? "suppressed" : undefined)
      ?? (iterationResult.waitObserveOnly ? "observing" : undefined)
      ?? (iterationResult.waitExpired ? "expired" : "active"),
    details: iterationResult.waitExpiryOutcome?.details,
    approvalId: iterationResult.waitApprovalId,
    observeOnly: iterationResult.waitObserveOnly,
    suppressed: iterationResult.waitSuppressed,
    expired: iterationResult.waitExpired,
    skipReason: iterationResult.skipReason,
  };
}
