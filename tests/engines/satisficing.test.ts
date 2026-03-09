import { describe, it, expect } from 'vitest';
import type { Gap } from '../../src/state/models.js';
import { SatisficingEngine } from '../../src/engines/satisficing.js';

describe('SatisficingEngine', () => {
  const engine = new SatisficingEngine();

  // ---------------------------------------------------------------------------
  // judgeCompletion
  // ---------------------------------------------------------------------------
  describe('judgeCompletion', () => {
    it('returns completed for empty gaps array', () => {
      const result = engine.judgeCompletion([]);
      expect(result.status).toBe('completed');
      expect(result.action).toBe('mark_done');
    });

    it('returns completed when all gaps ≤ threshold and avg confidence ≥ 0.7', () => {
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.88, target: 0.9, magnitude: 0.02, confidence: 0.9 },
        { dimension: 'quality', current: 0.95, target: 0.97, magnitude: 0.02, confidence: 0.8 },
      ];
      const result = engine.judgeCompletion(gaps);
      expect(result.status).toBe('completed');
      expect(result.action).toBe('mark_done');
    });

    it('returns needs_verification when all gaps ≤ threshold but avg confidence < 0.7', () => {
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.88, target: 0.9, magnitude: 0.03, confidence: 0.5 },
        { dimension: 'quality', current: 0.95, target: 0.97, magnitude: 0.04, confidence: 0.6 },
      ];
      const result = engine.judgeCompletion(gaps);
      expect(result.status).toBe('needs_verification');
      expect(result.action).toBe('generate_verification_tasks');
    });

    it('returns in_progress when some gaps exceed threshold', () => {
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.5, target: 0.9, magnitude: 0.4, confidence: 0.9 },
        { dimension: 'quality', current: 0.95, target: 0.97, magnitude: 0.02, confidence: 0.9 },
      ];
      const result = engine.judgeCompletion(gaps);
      expect(result.status).toBe('in_progress');
      expect(result.action).toBe('continue');
    });

    it('returns in_progress when all gaps exceed threshold', () => {
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.3, target: 0.9, magnitude: 0.6, confidence: 0.9 },
        { dimension: 'quality', current: 0.4, target: 0.8, magnitude: 0.4, confidence: 0.85 },
      ];
      const result = engine.judgeCompletion(gaps);
      expect(result.status).toBe('in_progress');
      expect(result.action).toBe('continue');
    });

    it('edge: gap exactly at threshold (0.05) counts as ≤ threshold → completed when confidence high', () => {
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.85, target: 0.9, magnitude: 0.05, confidence: 0.9 },
      ];
      const result = engine.judgeCompletion(gaps);
      expect(result.status).toBe('completed');
      expect(result.action).toBe('mark_done');
    });

    it('edge: confidence exactly at 0.7 → completed', () => {
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.88, target: 0.9, magnitude: 0.02, confidence: 0.7 },
      ];
      const result = engine.judgeCompletion(gaps);
      expect(result.status).toBe('completed');
      expect(result.action).toBe('mark_done');
    });

    it('mixed confidence values: avg determines outcome (avg < 0.7 → needs_verification)', () => {
      // avg = (0.9 + 0.4) / 2 = 0.65 < 0.7
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.88, target: 0.9, magnitude: 0.02, confidence: 0.9 },
        { dimension: 'quality', current: 0.94, target: 0.96, magnitude: 0.02, confidence: 0.4 },
      ];
      const result = engine.judgeCompletion(gaps);
      expect(result.status).toBe('needs_verification');
      expect(result.action).toBe('generate_verification_tasks');
    });

    it('mixed confidence values: avg determines outcome (avg ≥ 0.7 → completed)', () => {
      // avg = (0.9 + 0.5) / 2 = 0.7 ≥ 0.7
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.88, target: 0.9, magnitude: 0.02, confidence: 0.9 },
        { dimension: 'quality', current: 0.94, target: 0.96, magnitude: 0.02, confidence: 0.5 },
      ];
      const result = engine.judgeCompletion(gaps);
      expect(result.status).toBe('completed');
      expect(result.action).toBe('mark_done');
    });

    it('reason string mentions largest gap when in_progress', () => {
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.5, target: 0.9, magnitude: 0.4, confidence: 0.9 },
        { dimension: 'quality', current: 0.7, target: 0.9, magnitude: 0.2, confidence: 0.9 },
      ];
      const result = engine.judgeCompletion(gaps);
      expect(result.reason).toContain('0.40');
    });
  });

  // ---------------------------------------------------------------------------
  // isComplete
  // ---------------------------------------------------------------------------
  describe('isComplete', () => {
    it('returns true for empty gaps', () => {
      expect(engine.isComplete([])).toBe(true);
    });

    it('returns true when all gaps ≤ threshold and confidence is high', () => {
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.88, target: 0.9, magnitude: 0.02, confidence: 0.95 },
      ];
      expect(engine.isComplete(gaps)).toBe(true);
    });

    it('returns false when needs_verification', () => {
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.88, target: 0.9, magnitude: 0.02, confidence: 0.4 },
      ];
      expect(engine.isComplete(gaps)).toBe(false);
    });

    it('returns false when in_progress', () => {
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.5, target: 0.9, magnitude: 0.4, confidence: 0.95 },
      ];
      expect(engine.isComplete(gaps)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // needsVerification
  // ---------------------------------------------------------------------------
  describe('needsVerification', () => {
    it('returns true when all gaps small but confidence low', () => {
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.88, target: 0.9, magnitude: 0.02, confidence: 0.4 },
      ];
      expect(engine.needsVerification(gaps)).toBe(true);
    });

    it('returns false for empty gaps (trivially complete)', () => {
      expect(engine.needsVerification([])).toBe(false);
    });

    it('returns false when completed', () => {
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.88, target: 0.9, magnitude: 0.02, confidence: 0.95 },
      ];
      expect(engine.needsVerification(gaps)).toBe(false);
    });

    it('returns false when in_progress', () => {
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.5, target: 0.9, magnitude: 0.4, confidence: 0.4 },
      ];
      expect(engine.needsVerification(gaps)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Custom thresholds
  // ---------------------------------------------------------------------------
  describe('custom thresholds', () => {
    it('uses custom gapThreshold', () => {
      const strictEngine = new SatisficingEngine(0.01, 0.7);
      // magnitude 0.02 exceeds strict threshold of 0.01 → in_progress
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.88, target: 0.9, magnitude: 0.02, confidence: 0.95 },
      ];
      expect(strictEngine.judgeCompletion(gaps).status).toBe('in_progress');
    });

    it('uses custom confidenceThreshold', () => {
      const lenientEngine = new SatisficingEngine(0.05, 0.4);
      // confidence 0.5 is above lenient threshold of 0.4 → completed
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.88, target: 0.9, magnitude: 0.02, confidence: 0.5 },
      ];
      expect(lenientEngine.judgeCompletion(gaps).status).toBe('completed');
    });

    it('uses custom confidenceThreshold for needs_verification', () => {
      const highConfEngine = new SatisficingEngine(0.05, 0.95);
      // confidence 0.8 is below strict threshold of 0.95 → needs_verification
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.88, target: 0.9, magnitude: 0.02, confidence: 0.8 },
      ];
      expect(highConfEngine.judgeCompletion(gaps).status).toBe('needs_verification');
    });

    it('uses custom gapThreshold — gap exactly at custom threshold is ≤ (completed)', () => {
      const customEngine = new SatisficingEngine(0.1, 0.7);
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.8, target: 0.9, magnitude: 0.1, confidence: 0.9 },
      ];
      expect(customEngine.judgeCompletion(gaps).status).toBe('completed');
    });
  });
});
