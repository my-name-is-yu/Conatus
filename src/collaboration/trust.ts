import { TrustBalance } from '../state/models.js';
import { debug } from '../debug.js';

export class TrustManager {
  private clamp(value: number): number {
    return Math.min(1.0, Math.max(0.0, value));
  }

  updateOnSuccess(trustBalance: TrustBalance, goalId?: string): TrustBalance {
    const delta = 0.05;
    const updated: TrustBalance = {
      global: this.clamp(trustBalance.global + delta),
      per_goal: { ...trustBalance.per_goal },
    };
    if (goalId !== undefined && goalId in updated.per_goal) {
      updated.per_goal[goalId] = this.clamp(updated.per_goal[goalId] + delta);
    }
    debug('trust-manager', 'trust balance changes', { event: 'success', delta, before: trustBalance.global, after: updated.global, goal_id: goalId ?? null });
    return updated;
  }

  updateOnFailure(trustBalance: TrustBalance, goalId?: string): TrustBalance {
    const delta = 0.15;
    const updated: TrustBalance = {
      global: this.clamp(trustBalance.global - delta),
      per_goal: { ...trustBalance.per_goal },
    };
    if (goalId !== undefined && goalId in updated.per_goal) {
      updated.per_goal[goalId] = this.clamp(updated.per_goal[goalId] - delta);
    }
    debug('trust-manager', 'trust balance changes', { event: 'failure', delta, before: trustBalance.global, after: updated.global, goal_id: goalId ?? null });
    return updated;
  }

  updateOnIrreversibleSuccess(trustBalance: TrustBalance, goalId?: string): TrustBalance {
    const delta = 0.1;
    const updated: TrustBalance = {
      global: this.clamp(trustBalance.global + delta),
      per_goal: { ...trustBalance.per_goal },
    };
    if (goalId !== undefined && goalId in updated.per_goal) {
      updated.per_goal[goalId] = this.clamp(updated.per_goal[goalId] + delta);
    }
    debug('trust-manager', 'approval decisions', { event: 'irreversible_success', delta, before: trustBalance.global, after: updated.global, goal_id: goalId ?? null });
    return updated;
  }

  updateOnIrreversibleFailure(trustBalance: TrustBalance, goalId?: string): TrustBalance {
    const delta = 0.3;
    const updated: TrustBalance = {
      global: this.clamp(trustBalance.global - delta),
      per_goal: { ...trustBalance.per_goal },
    };
    if (goalId !== undefined && goalId in updated.per_goal) {
      updated.per_goal[goalId] = this.clamp(updated.per_goal[goalId] - delta);
    }
    debug('trust-manager', 'approval decisions', { event: 'irreversible_failure', delta, before: trustBalance.global, after: updated.global, goal_id: goalId ?? null });
    return updated;
  }
}
