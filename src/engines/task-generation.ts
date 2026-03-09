import type { Goal, Gap } from '../state/models.js';
import { debug } from '../debug.js';

export interface Task {
  id: string;
  goal_id: string;
  target_dimension: string;
  description: string;
  priority: number;
  generation_depth: number;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  created_at: string;
}

export class TaskGenerationEngine {
  /**
   * Convert gaps into prioritized tasks.
   * - Skip gaps with magnitude < 0.05
   * - Respect max_generation_depth and max_subtasks constraints
   * - Sort by priority (magnitude * confidence) descending
   */
  generateTasks(gaps: Gap[], goal: Goal, depth: number = 0): Task[] {
    const tasks: Task[] = [];
    const { max_generation_depth, max_subtasks } = goal.constraints;

    for (const gap of gaps) {
      if (gap.magnitude < 0.05) continue;
      if (depth >= max_generation_depth) continue;
      if (tasks.length >= max_subtasks) break;

      tasks.push({
        id: `task-${goal.id}-${gap.dimension}-${depth}`,
        goal_id: goal.id,
        target_dimension: gap.dimension,
        description: this.describeTask(gap, goal),
        priority: gap.magnitude * gap.confidence,
        generation_depth: depth,
        status: 'pending',
        created_at: new Date().toISOString(),
      });
    }

    const sorted = tasks.sort((a, b) => b.priority - a.priority);
    if (sorted.length > 0) {
      debug('task-generation', 'task generated', { goal_id: goal.id, top_task: sorted[0].description, priority: sorted[0].priority, reason: `gap dimension: ${sorted[0].target_dimension}` });
    }
    return sorted;
  }

  /**
   * Generate a human-readable task description from a gap.
   */
  private describeTask(gap: Gap, goal: Goal): string {
    const direction = gap.current < gap.target ? 'Increase' : 'Decrease';
    const pct = (gap.magnitude * 100).toFixed(0);
    return `${direction} ${gap.dimension} from ${gap.current.toFixed(2)} to ${gap.target.toFixed(2)} (${pct}% gap) for "${goal.title}"`;
  }

  /**
   * Filter tasks by minimum priority threshold (distance_filter from goal constraints).
   */
  filterByRelevance(tasks: Task[], goal: Goal): Task[] {
    const threshold = goal.constraints.distance_filter;
    // distance_filter is a relevance threshold: only keep tasks with priority above (1 - distance_filter)
    // Actually, tasks with priority >= (1 - distance_filter) * max_priority
    // Simpler interpretation: filter tasks whose priority is above a minimum
    const minPriority = 1.0 - threshold; // distance_filter 0.7 means min priority 0.3
    return tasks.filter(t => t.priority >= minPriority);
  }

  /**
   * Get the highest priority task.
   */
  getTopTask(gaps: Gap[], goal: Goal): Task | null {
    const tasks = this.generateTasks(gaps, goal);
    return tasks.length > 0 ? tasks[0] : null;
  }
}
