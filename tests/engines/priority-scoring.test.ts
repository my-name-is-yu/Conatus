import { describe, it, expect, beforeEach } from 'vitest';
import { PriorityScoringEngine, type OpportunityEvent } from '../../src/engines/priority-scoring.js';
import { Goal, Gap } from '../../src/state/models.js';

// Fixed "now" for deterministic tests
const NOW = new Date('2026-03-10T00:00:00Z');

function makeGap(magnitude: number, confidence: number, dimension = 'progress'): Gap {
  return Gap.parse({ dimension, current: 0, target: 1, magnitude, confidence });
}

describe('PriorityScoringEngine', () => {
  let engine: PriorityScoringEngine;

  beforeEach(() => {
    engine = new PriorityScoringEngine();
  });

  // ---------------------------------------------------------------------------
  describe('deadlineScore', () => {
    it('returns 0 when goal has no deadline', () => {
      const goal = Goal.parse({ title: 'No deadline', created_at: '2026-03-01T00:00:00Z' });
      expect(engine.deadlineScore(goal, NOW)).toBe(0);
    });

    it('returns 0 when deadline equals created_at', () => {
      const goal = Goal.parse({
        title: 'Zero span',
        created_at: '2026-03-10T00:00:00Z',
        deadline: '2026-03-10T00:00:00Z',
      });
      expect(engine.deadlineScore(goal, NOW)).toBe(0);
    });

    it('returns 0 when deadline is before created_at', () => {
      const goal = Goal.parse({
        title: 'Inverted',
        created_at: '2026-03-10T00:00:00Z',
        deadline: '2026-03-09T00:00:00Z',
      });
      expect(engine.deadlineScore(goal, NOW)).toBe(0);
    });

    it('score increases as deadline approaches', () => {
      const created = '2026-03-01T00:00:00Z';
      const deadline = '2026-03-20T00:00:00Z'; // 19-day span

      const goalEarly = Goal.parse({ title: 'Early', created_at: created, deadline });
      const goalLate = Goal.parse({ title: 'Late', created_at: created, deadline });

      // Evaluate at day 5 (early) vs day 15 (late)
      const nowEarly = new Date('2026-03-06T00:00:00Z'); // 5 days in
      const nowLate = new Date('2026-03-16T00:00:00Z');  // 15 days in

      const scoreEarly = engine.deadlineScore(goalEarly, nowEarly);
      const scoreLate = engine.deadlineScore(goalLate, nowLate);

      expect(scoreLate).toBeGreaterThan(scoreEarly);
    });

    it('handles past deadlines as max urgency (remainingRatio clamped to 0)', () => {
      const goal = Goal.parse({
        title: 'Overdue',
        created_at: '2026-01-01T00:00:00Z',
        deadline: '2026-02-01T00:00:00Z', // already past relative to NOW
      });
      // remainingRatio = 0 => urgency = 1^2 = 1; gap = 1 - progress(0) = 1
      expect(engine.deadlineScore(goal, NOW)).toBeCloseTo(1.0);
    });

    it('considers progress in state_vector (higher progress lowers score)', () => {
      const base = {
        title: 'With progress',
        created_at: '2026-03-01T00:00:00Z',
        deadline: '2026-03-20T00:00:00Z',
      };

      const goalLow = Goal.parse({
        ...base,
        state_vector: { progress: { value: 0.1, confidence: 1.0, source: 'tool_output' } },
      });
      const goalHigh = Goal.parse({
        ...base,
        state_vector: { progress: { value: 0.9, confidence: 1.0, source: 'tool_output' } },
      });

      const scoreLow = engine.deadlineScore(goalLow, NOW);
      const scoreHigh = engine.deadlineScore(goalHigh, NOW);

      expect(scoreLow).toBeGreaterThan(scoreHigh);
    });

    it('computes score correctly at midpoint with no progress', () => {
      // created=Mar 1, deadline=Mar 21 (20 days), now=Mar 11 (10 days in = midpoint)
      const goal = Goal.parse({
        title: 'Midpoint',
        created_at: '2026-03-01T00:00:00Z',
        deadline: '2026-03-21T00:00:00Z',
      });
      const midpoint = new Date('2026-03-11T00:00:00Z');
      // remainingRatio = 0.5, urgency = (1 - 0.5)^2 = 0.25, gap = 1
      expect(engine.deadlineScore(goal, midpoint)).toBeCloseTo(0.25, 5);
    });
  });

  // ---------------------------------------------------------------------------
  describe('dissatisfactionScore', () => {
    it('returns 0 for empty gaps array', () => {
      expect(engine.dissatisfactionScore([], undefined, NOW)).toBe(0);
    });

    it('returns maxGap when no lastActionTime provided', () => {
      const gaps = [makeGap(0.8, 1.0), makeGap(0.5, 0.9)];
      // max(0.8*1.0, 0.5*0.9) = max(0.8, 0.45) = 0.8
      expect(engine.dissatisfactionScore(gaps, undefined, NOW)).toBeCloseTo(0.8);
    });

    it('returns maxGap with no decay at 0 hours since last action', () => {
      const gaps = [makeGap(0.6, 1.0)];
      // staleness = 0, decay = 1.0
      expect(engine.dissatisfactionScore(gaps, NOW, NOW)).toBeCloseTo(0.6);
    });

    it('applies 15% decay after 12 hours', () => {
      const gaps = [makeGap(1.0, 1.0)];
      const lastAction = new Date(NOW.getTime() - 12 * 60 * 60 * 1000); // 12h ago
      // staleness = min(1, 12/24) = 0.5, decay = 1 - 0.5 * 0.3 = 0.85
      expect(engine.dissatisfactionScore(gaps, lastAction, NOW)).toBeCloseTo(0.85);
    });

    it('applies 30% decay after 24 hours', () => {
      const gaps = [makeGap(1.0, 1.0)];
      const lastAction = new Date(NOW.getTime() - 24 * 60 * 60 * 1000); // 24h ago
      // staleness = 1.0, decay = 1 - 1.0 * 0.3 = 0.7
      expect(engine.dissatisfactionScore(gaps, lastAction, NOW)).toBeCloseTo(0.7);
    });

    it('caps decay at 30% even after 48+ hours', () => {
      const gaps = [makeGap(1.0, 1.0)];
      const lastAction = new Date(NOW.getTime() - 48 * 60 * 60 * 1000); // 48h ago
      // staleness clamped to 1.0, decay = 0.7
      expect(engine.dissatisfactionScore(gaps, lastAction, NOW)).toBeCloseTo(0.7);
    });

    it('uses the highest magnitude * confidence across all gaps', () => {
      const gaps = [
        makeGap(0.4, 0.9, 'a'),  // 0.36
        makeGap(0.7, 0.8, 'b'),  // 0.56
        makeGap(0.9, 0.5, 'c'),  // 0.45
      ];
      expect(engine.dissatisfactionScore(gaps, undefined, NOW)).toBeCloseTo(0.56);
    });
  });

  // ---------------------------------------------------------------------------
  describe('opportunityScore', () => {
    it('returns 0 for empty events array', () => {
      expect(engine.opportunityScore([], NOW)).toBe(0);
    });

    it('returns full value for a brand-new event (age = 0)', () => {
      const events: OpportunityEvent[] = [
        { detected_at: NOW.toISOString(), value: 0.8, description: 'Fresh' },
      ];
      expect(engine.opportunityScore(events, NOW)).toBeCloseTo(0.8);
    });

    it('decays to 0 after 12 hours', () => {
      const detectedAt = new Date(NOW.getTime() - 12 * 60 * 60 * 1000).toISOString();
      const events: OpportunityEvent[] = [
        { detected_at: detectedAt, value: 0.9, description: 'Old' },
      ];
      // freshness = max(0, 1 - 12/12) = 0
      expect(engine.opportunityScore(events, NOW)).toBeCloseTo(0);
    });

    it('decays linearly at 6 hours (50% freshness)', () => {
      const detectedAt = new Date(NOW.getTime() - 6 * 60 * 60 * 1000).toISOString();
      const events: OpportunityEvent[] = [
        { detected_at: detectedAt, value: 1.0, description: 'Half-fresh' },
      ];
      // freshness = 1 - 6/12 = 0.5
      expect(engine.opportunityScore(events, NOW)).toBeCloseTo(0.5);
    });

    it('returns 0 for events older than 12 hours', () => {
      const detectedAt = new Date(NOW.getTime() - 20 * 60 * 60 * 1000).toISOString();
      const events: OpportunityEvent[] = [
        { detected_at: detectedAt, value: 0.9, description: 'Stale' },
      ];
      expect(engine.opportunityScore(events, NOW)).toBe(0);
    });

    it('uses the freshest event when multiple events provided', () => {
      const fresh = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
      const stale = new Date(NOW.getTime() - 10 * 60 * 60 * 1000).toISOString(); // 10h ago
      const events: OpportunityEvent[] = [
        { detected_at: stale, value: 0.9, description: 'Old event' },
        { detected_at: fresh, value: 0.6, description: 'New event' },
      ];
      // Freshest is the 2h-old one: freshness = 1 - 2/12 = 0.833..., score = 0.6 * 0.833 = 0.5
      const expected = 0.6 * (1.0 - 2 / 12);
      expect(engine.opportunityScore(events, NOW)).toBeCloseTo(expected, 5);
    });
  });

  // ---------------------------------------------------------------------------
  describe('motivationScore', () => {
    it('returns max of deadline, dissatisfaction, opportunity scores', () => {
      // Set up goal with a very close deadline for high deadline score
      const goal = Goal.parse({
        title: 'Urgent',
        type: 'deadline',
        created_at: '2026-03-01T00:00:00Z',
        deadline: '2026-03-11T00:00:00Z', // 1 day after NOW
      });
      const gaps = [makeGap(0.3, 0.5)]; // low dissatisfaction
      const score = engine.motivationScore(goal, gaps, { now: NOW });

      const dl = engine.deadlineScore(goal, NOW);
      const ds = engine.dissatisfactionScore(gaps, undefined, NOW);
      expect(score).toBeCloseTo(Math.max(dl, ds, 0));
    });

    it('applies hysteresis bonus of 0.1 when isLastActiveGoal is true', () => {
      const goal = Goal.parse({ title: 'Active goal', created_at: NOW.toISOString() });
      const gaps = [makeGap(0.4, 1.0)]; // dissatisfaction = 0.4

      const scoreNormal = engine.motivationScore(goal, gaps, { now: NOW });
      const scoreHysteresis = engine.motivationScore(goal, gaps, { isLastActiveGoal: true, now: NOW });

      expect(scoreHysteresis).toBeCloseTo(scoreNormal + 0.1, 5);
    });

    it('clamps total score to 1.0 even with hysteresis', () => {
      const goal = Goal.parse({ title: 'High scorer', created_at: NOW.toISOString() });
      const gaps = [makeGap(1.0, 1.0)]; // dissatisfaction = 1.0

      const score = engine.motivationScore(goal, gaps, { isLastActiveGoal: true, now: NOW });
      expect(score).toBe(1.0);
    });

    it('incorporates opportunity events', () => {
      const goal = Goal.parse({ title: 'Opportunity', created_at: NOW.toISOString() });
      const gaps: Gap[] = [];
      const events: OpportunityEvent[] = [
        { detected_at: NOW.toISOString(), value: 0.9, description: 'Hot lead' },
      ];

      const score = engine.motivationScore(goal, gaps, { opportunityEvents: events, now: NOW });
      expect(score).toBeCloseTo(0.9);
    });

    it('returns 0 when goal has no deadline, no gaps, and no events', () => {
      const goal = Goal.parse({ title: 'Empty', created_at: NOW.toISOString() });
      expect(engine.motivationScore(goal, [], { now: NOW })).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('rankGoals', () => {
    it('sorts goals by motivation score descending', () => {
      const goalA = Goal.parse({
        title: 'Low priority',
        created_at: NOW.toISOString(),
      });
      const goalB = Goal.parse({
        title: 'High priority',
        created_at: NOW.toISOString(),
      });

      const results = engine.rankGoals(
        [
          { goal: goalA, gaps: [makeGap(0.2, 0.5)] }, // score ~= 0.1
          { goal: goalB, gaps: [makeGap(0.9, 1.0)] }, // score ~= 0.9
        ],
        undefined,
        NOW
      );

      expect(results[0].goal.title).toBe('High priority');
      expect(results[1].goal.title).toBe('Low priority');
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it('applies hysteresis to the lastActiveGoalId goal', () => {
      const goalA = Goal.parse({ id: 'goal-aaa', title: 'Last active', created_at: NOW.toISOString() });
      const goalB = Goal.parse({ id: 'goal-bbb', title: 'Competitor', created_at: NOW.toISOString() });

      // Both have equal dissatisfaction score
      const gapsA = [makeGap(0.5, 1.0)];
      const gapsB = [makeGap(0.5, 1.0)];

      const results = engine.rankGoals(
        [
          { goal: goalB, gaps: gapsB },
          { goal: goalA, gaps: gapsA },
        ],
        goalA.id,
        NOW
      );

      // goalA gets +0.1 hysteresis so it ranks first
      expect(results[0].goal.id).toBe(goalA.id);
      expect(results[0].score).toBeCloseTo(results[1].score + 0.1, 5);
    });

    it('returns breakdown object with individual component scores', () => {
      const goal = Goal.parse({
        title: 'Breakdown test',
        type: 'deadline',
        created_at: '2026-03-01T00:00:00Z',
        deadline: '2026-03-21T00:00:00Z',
        state_vector: { progress: { value: 0.0, confidence: 1.0, source: 'tool_output' } },
      });
      const gaps = [makeGap(0.5, 0.8)];
      const events: OpportunityEvent[] = [
        { detected_at: NOW.toISOString(), value: 0.3, description: 'Signal' },
      ];

      const results = engine.rankGoals([{ goal, gaps, opportunityEvents: events }], undefined, NOW);
      const { breakdown } = results[0];

      expect(breakdown.deadline).toBeGreaterThanOrEqual(0);
      expect(breakdown.dissatisfaction).toBeGreaterThanOrEqual(0);
      expect(breakdown.opportunity).toBeGreaterThanOrEqual(0);

      // Deadline component: created=Mar1, deadline=Mar21 (20d), now=Mar10 (9d in)
      // remainingRatio = 11/20 = 0.55, urgency = (0.45)^2 = 0.2025, gap=1 => 0.2025
      expect(breakdown.deadline).toBeCloseTo(0.2025, 3);
      // Dissatisfaction: max gap = 0.5 * 0.8 = 0.4
      expect(breakdown.dissatisfaction).toBeCloseTo(0.4, 5);
      // Opportunity: age=0h, freshness=1.0, value=0.3 => 0.3
      expect(breakdown.opportunity).toBeCloseTo(0.3, 5);
    });

    it('returns empty array for empty input', () => {
      expect(engine.rankGoals([], undefined, NOW)).toEqual([]);
    });

    it('handles single goal correctly', () => {
      const goal = Goal.parse({ title: 'Solo', created_at: NOW.toISOString() });
      const results = engine.rankGoals([{ goal, gaps: [makeGap(0.7, 0.9)] }], undefined, NOW);
      expect(results).toHaveLength(1);
      expect(results[0].score).toBeCloseTo(0.63); // 0.7 * 0.9
    });

    it('clamps hysteresis-boosted scores to 1.0 in rankGoals', () => {
      const goal = Goal.parse({ id: 'goal-max', title: 'Max score', created_at: NOW.toISOString() });
      const gaps = [makeGap(1.0, 1.0)]; // dissatisfaction = 1.0

      const results = engine.rankGoals([{ goal, gaps }], goal.id, NOW);
      expect(results[0].score).toBe(1.0);
    });
  });
});
