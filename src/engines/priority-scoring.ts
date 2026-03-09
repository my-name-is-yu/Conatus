import type { Goal, Gap } from '../state/models.js';

export interface OpportunityEvent {
  detected_at: string; // ISO date
  value: number; // 0-1
  description: string;
}

export class PriorityScoringEngine {
  /**
   * Deadline-driven score: urgency increases exponentially as deadline approaches.
   * urgency = (1 - remaining_ratio)^2
   * score = urgency * gap
   */
  deadlineScore(goal: Goal, now: Date = new Date()): number {
    if (!goal.deadline) return 0;

    const deadline = new Date(goal.deadline).getTime();
    const created = new Date(goal.created_at).getTime();
    const nowMs = now.getTime();

    if (deadline <= created) return 0;

    const remainingRatio = Math.max(0, (deadline - nowMs) / (deadline - created));

    // Use progress from state_vector, default to 0
    const progress = goal.state_vector.progress?.value ?? 0;
    const gap = 1.0 - progress;
    const urgency = (1.0 - remainingRatio) ** 2;
    return urgency * gap;
  }

  /**
   * Dissatisfaction-driven score: largest gap * decay over time.
   * staleness = min(1, hours_since_last_action / 24)
   * decay = 1 - (staleness * 0.3)  // max 30% decay (habituation)
   */
  dissatisfactionScore(gaps: Gap[], lastActionTime?: Date, now: Date = new Date()): number {
    if (gaps.length === 0) return 0;

    const maxGap = Math.max(...gaps.map(g => g.magnitude * g.confidence));

    if (!lastActionTime) return maxGap;

    const hoursSince = (now.getTime() - lastActionTime.getTime()) / (1000 * 60 * 60);
    const staleness = Math.min(1.0, hoursSince / 24.0);
    const decay = 1.0 - (staleness * 0.3);
    return maxGap * decay;
  }

  /**
   * Opportunity-driven score: freshness decays over 12 hours.
   */
  opportunityScore(events: OpportunityEvent[], now: Date = new Date()): number {
    if (events.length === 0) return 0;

    const freshest = events.reduce((a, b) =>
      new Date(a.detected_at).getTime() > new Date(b.detected_at).getTime() ? a : b
    );

    const ageHours = (now.getTime() - new Date(freshest.detected_at).getTime()) / (1000 * 60 * 60);
    const freshness = Math.max(0, 1.0 - ageHours / 12.0);
    return freshest.value * freshness;
  }

  /**
   * Combined score: max of all three types.
   * Hysteresis: +0.1 bonus if this goal was the last active goal.
   */
  motivationScore(
    goal: Goal,
    gaps: Gap[],
    options: {
      lastActionTime?: Date;
      opportunityEvents?: OpportunityEvent[];
      isLastActiveGoal?: boolean;
      now?: Date;
    } = {}
  ): number {
    const now = options.now ?? new Date();
    const dl = this.deadlineScore(goal, now);
    const ds = this.dissatisfactionScore(gaps, options.lastActionTime, now);
    const op = this.opportunityScore(options.opportunityEvents ?? [], now);

    let score = Math.max(dl, ds, op);
    if (options.isLastActiveGoal) {
      score += 0.1; // hysteresis to prevent oscillation
    }
    return Math.min(1.0, score); // clamp to [0, 1]
  }

  /**
   * Rank multiple goals and return sorted by motivation score descending.
   */
  rankGoals(
    goals: Array<{
      goal: Goal;
      gaps: Gap[];
      lastActionTime?: Date;
      opportunityEvents?: OpportunityEvent[];
    }>,
    lastActiveGoalId?: string,
    now?: Date
  ): Array<{
    goal: Goal;
    score: number;
    breakdown: { deadline: number; dissatisfaction: number; opportunity: number };
  }> {
    return goals
      .map(({ goal, gaps, lastActionTime, opportunityEvents }) => {
        const dl = this.deadlineScore(goal, now);
        const ds = this.dissatisfactionScore(gaps, lastActionTime, now);
        const op = this.opportunityScore(opportunityEvents ?? [], now);
        let score = Math.max(dl, ds, op);
        if (goal.id === lastActiveGoalId) score = Math.min(1.0, score + 0.1);
        return { goal, score, breakdown: { deadline: dl, dissatisfaction: ds, opportunity: op } };
      })
      .sort((a, b) => b.score - a.score);
  }
}
