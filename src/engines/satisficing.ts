import type { Gap } from '../state/models.js';
import { debug } from '../debug.js';

export type CompletionAction = 'mark_done' | 'generate_verification_tasks' | 'continue';
export type CompletionStatus = 'completed' | 'needs_verification' | 'in_progress';

export interface CompletionJudgment {
  status: CompletionStatus;
  action: CompletionAction;
  reason: string;
}

export class SatisficingEngine {
  private readonly gapThreshold: number;
  private readonly confidenceThreshold: number;

  constructor(gapThreshold = 0.05, confidenceThreshold = 0.7) {
    this.gapThreshold = gapThreshold;
    this.confidenceThreshold = confidenceThreshold;
  }

  /**
   * Judge whether a goal is complete based on its gaps.
   *
   * - All gaps ≤ threshold AND avg confidence ≥ 0.7 → completed (mark_done)
   * - All gaps ≤ threshold AND avg confidence < 0.7 → needs_verification
   * - Otherwise → in_progress (continue)
   */
  judgeCompletion(gaps: Gap[]): CompletionJudgment {
    if (gaps.length === 0) {
      const result = {
        status: 'completed' as CompletionStatus,
        action: 'mark_done' as CompletionAction,
        reason: 'No dimensions to evaluate — goal is trivially complete.',
      };
      debug('satisficing', 'threshold check', { gaps_count: 0, status: result.status });
      return result;
    }

    const allBelowThreshold = gaps.every(g => g.magnitude <= this.gapThreshold);
    const avgConfidence = gaps.reduce((sum, g) => sum + g.confidence, 0) / gaps.length;
    debug('satisficing', 'threshold check', { gaps_count: gaps.length, all_below_threshold: allBelowThreshold, avg_confidence: avgConfidence });

    if (allBelowThreshold && avgConfidence >= this.confidenceThreshold) {
      const result = {
        status: 'completed' as CompletionStatus,
        action: 'mark_done' as CompletionAction,
        reason: `All gaps ≤ ${this.gapThreshold} with avg confidence ${avgConfidence.toFixed(2)}.`,
      };
      debug('satisficing', 'satisfied', { status: result.status, reason: result.reason });
      return result;
    }

    if (allBelowThreshold && avgConfidence < this.confidenceThreshold) {
      const result = {
        status: 'needs_verification' as CompletionStatus,
        action: 'generate_verification_tasks' as CompletionAction,
        reason: `All gaps ≤ ${this.gapThreshold} but avg confidence ${avgConfidence.toFixed(2)} < ${this.confidenceThreshold}. Verification needed.`,
      };
      debug('satisficing', 'not satisfied: low confidence', { status: result.status });
      return result;
    }

    const maxGap = Math.max(...gaps.map(g => g.magnitude));
    const result = {
      status: 'in_progress' as CompletionStatus,
      action: 'continue' as CompletionAction,
      reason: `Largest gap: ${maxGap.toFixed(2)}. Work remains.`,
    };
    debug('satisficing', 'not satisfied: gaps remain', { status: result.status, max_gap: maxGap });
    return result;
  }

  /**
   * Convenience: is the goal done (completed status)?
   */
  isComplete(gaps: Gap[]): boolean {
    return this.judgeCompletion(gaps).status === 'completed';
  }

  /**
   * Convenience: does the goal need verification?
   */
  needsVerification(gaps: Gap[]): boolean {
    return this.judgeCompletion(gaps).status === 'needs_verification';
  }
}
