export type StallCause = 'information_deficit' | 'permission_deficit' | 'capability_deficit' | 'external_dependency';

export type RecoveryStrategy =
  | { type: 'investigate'; description: string }
  | { type: 'escalate'; description: string }
  | { type: 'redefine_goal'; description: string }
  | { type: 'switch_task'; description: string };

export interface StallResult {
  tool_name: string;
  cause: StallCause;
  failure_count: number;
  recovery: RecoveryStrategy;
}

export class StallDetectionEngine {
  private consecutiveFailures: Map<string, number> = new Map();
  private readonly failureThreshold: number;

  constructor(failureThreshold = 3) {
    this.failureThreshold = failureThreshold;
  }

  /**
   * Record a tool failure. Returns a StallResult if threshold is reached.
   */
  onFailure(toolName: string, errorMessage?: string): StallResult | null {
    const count = (this.consecutiveFailures.get(toolName) ?? 0) + 1;
    this.consecutiveFailures.set(toolName, count);

    if (count >= this.failureThreshold) {
      return this.classifyAndRecover(toolName, count, errorMessage);
    }
    return null;
  }

  /**
   * Record a tool success. Resets the failure counter for that tool.
   */
  onSuccess(toolName: string): void {
    this.consecutiveFailures.set(toolName, 0);
  }

  /**
   * Get current failure count for a tool.
   */
  getFailureCount(toolName: string): number {
    return this.consecutiveFailures.get(toolName) ?? 0;
  }

  /**
   * Check if a tool is currently in stall state.
   */
  isStalled(toolName: string): boolean {
    return this.getFailureCount(toolName) >= this.failureThreshold;
  }

  /**
   * Reset all failure counters.
   */
  reset(): void {
    this.consecutiveFailures.clear();
  }

  /**
   * Classify the stall cause and suggest recovery strategy.
   *
   * Heuristics:
   * - Read/Grep/Glob failures → information_deficit → investigate
   * - Bash with permission errors → permission_deficit → escalate to human
   * - Write/Edit failures → capability_deficit → redefine goal
   * - Other / network-related → external_dependency → switch task
   */
  private classifyAndRecover(toolName: string, count: number, errorMessage?: string): StallResult {
    const cause = this.classifyCause(toolName, errorMessage);
    const recovery = this.suggestRecovery(cause, toolName);
    return { tool_name: toolName, cause, failure_count: count, recovery };
  }

  private classifyCause(toolName: string, errorMessage?: string): StallCause {
    const msg = (errorMessage ?? '').toLowerCase();

    // Permission-related errors
    if (msg.includes('permission') || msg.includes('denied') || msg.includes('forbidden') || msg.includes('eacces')) {
      return 'permission_deficit';
    }

    // Information-seeking tools
    if (['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'].includes(toolName)) {
      return 'information_deficit';
    }

    // Writing/editing tools
    if (['Write', 'Edit', 'NotebookEdit'].includes(toolName)) {
      return 'capability_deficit';
    }

    // Network/external errors
    if (msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('network') || msg.includes('fetch')) {
      return 'external_dependency';
    }

    // Bash — could be anything, use error message to guess
    if (toolName === 'Bash') {
      if (msg.includes('not found') || msg.includes('no such file')) return 'information_deficit';
      if (msg.includes('permission')) return 'permission_deficit';
      return 'capability_deficit';
    }

    return 'external_dependency';
  }

  private suggestRecovery(cause: StallCause, toolName: string): RecoveryStrategy {
    switch (cause) {
      case 'information_deficit':
        return {
          type: 'investigate',
          description: `${toolName} failed repeatedly. Try alternative search strategies or verify the target exists.`,
        };
      case 'permission_deficit':
        return {
          type: 'escalate',
          description: `${toolName} blocked by permissions. Escalate to human for access or approval.`,
        };
      case 'capability_deficit':
        return {
          type: 'redefine_goal',
          description: `${toolName} cannot complete this action. Consider breaking the task into smaller steps or using a different approach.`,
        };
      case 'external_dependency':
        return {
          type: 'switch_task',
          description: `${toolName} blocked by external dependency. Switch to another task and retry later.`,
        };
    }
  }
}
