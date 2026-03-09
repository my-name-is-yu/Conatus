import type { Gap } from '../state/models.js';

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
      return {
        status: 'completed',
        action: 'mark_done',
        reason: 'No dimensions to evaluate — goal is trivially complete.',
      };
    }

    const allBelowThreshold = gaps.every(g => g.magnitude <= this.gapThreshold);
    const avgConfidence = gaps.reduce((sum, g) => sum + g.confidence, 0) / gaps.length;

    if (allBelowThreshold && avgConfidence >= this.confidenceThreshold) {
      return {
        status: 'completed',
        action: 'mark_done',
        reason: `All gaps ≤ ${this.gapThreshold} with avg confidence ${avgConfidence.toFixed(2)}.`,
      };
    }

    if (allBelowThreshold && avgConfidence < this.confidenceThreshold) {
      return {
        status: 'needs_verification',
        action: 'generate_verification_tasks',
        reason: `All gaps ≤ ${this.gapThreshold} but avg confidence ${avgConfidence.toFixed(2)} < ${this.confidenceThreshold}. Verification needed.`,
      };
    }

    const maxGap = Math.max(...gaps.map(g => g.magnitude));
    return {
      status: 'in_progress',
      action: 'continue',
      reason: `Largest gap: ${maxGap.toFixed(2)}. Work remains.`,
    };
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
