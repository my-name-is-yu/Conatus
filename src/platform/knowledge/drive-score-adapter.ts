// ─── DriveScorer interface ───

/**
 * Minimal interface for drive-based memory management.
 * Allows MemoryLifecycleManager to query dissatisfaction scores
 * without depending on the full DriveScorer module.
 */
export interface IDriveScorer {
  /**
   * Returns a dissatisfaction score [0, 1+] for a dimension.
   * Used to determine compression delays.
   */
  getDissatisfactionScore(dimension: string): number;
}

/**
 * DriveScoreAdapter adapts DriveScore[] output from DriveScorer
 * to the IDriveScorer interface expected by MemoryLifecycleManager.
 *
 * Usage:
 *   const adapter = new DriveScoreAdapter();
 *   // After each drive scoring step in CoreLoop:
 *   adapter.update(driveScores);
 *   // MemoryLifecycleManager reads via getDissatisfactionScore()
 */
export class DriveScoreAdapter implements IDriveScorer {
  private readonly scores: Map<string, number> = new Map();

  /**
   * Replace the stored drive scores with the latest batch.
   * Each entry must have a dimension_name and dissatisfaction score.
   */
  update(driveScores: Array<{ dimension_name: string; dissatisfaction: number }>): void {
    this.scores.clear();
    for (const s of driveScores) {
      this.scores.set(s.dimension_name, s.dissatisfaction);
    }
  }

  /**
   * Returns the stored dissatisfaction score for the given dimension.
   * Returns 0 if the dimension is unknown (safe default: no delay inflation).
   */
  getDissatisfactionScore(dimension: string): number {
    return this.scores.get(dimension) ?? 0;
  }
}
