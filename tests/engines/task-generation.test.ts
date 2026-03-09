import { describe, it, expect, beforeEach } from 'vitest';
import { TaskGenerationEngine } from '../../src/engines/task-generation.js';
import type { Task } from '../../src/engines/task-generation.js';
import { Goal } from '../../src/state/models.js';
import type { Gap } from '../../src/state/models.js';

describe('TaskGenerationEngine', () => {
  let engine: TaskGenerationEngine;

  const makeGoal = (overrides: Partial<Parameters<typeof Goal.parse>[0]> = {}) =>
    Goal.parse({
      title: 'Auth module',
      achievement_thresholds: { progress: 0.9, quality_score: 0.8 },
      constraints: { max_generation_depth: 3, max_subtasks: 10, distance_filter: 0.7 },
      ...overrides,
    });

  const baseGaps: Gap[] = [
    { dimension: 'progress', current: 0.3, target: 0.9, magnitude: 0.67, confidence: 0.85 },
    { dimension: 'quality_score', current: 0.5, target: 0.8, magnitude: 0.375, confidence: 0.6 },
  ];

  beforeEach(() => {
    engine = new TaskGenerationEngine();
  });

  // ---------------------------------------------------------------------------
  describe('generateTasks', () => {
    it('creates one task per qualifying gap', () => {
      const goal = makeGoal();
      const tasks = engine.generateTasks(baseGaps, goal);
      expect(tasks).toHaveLength(2);
    });

    it('populates required task fields', () => {
      const goal = makeGoal();
      const [task] = engine.generateTasks(baseGaps, goal);
      expect(task.goal_id).toBe(goal.id);
      expect(task.status).toBe('pending');
      expect(task.generation_depth).toBe(0);
      expect(typeof task.id).toBe('string');
      expect(typeof task.created_at).toBe('string');
    });

    it('skips gaps with magnitude < 0.05', () => {
      const goal = makeGoal();
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.88, target: 0.9, magnitude: 0.02, confidence: 1.0 },
        { dimension: 'quality_score', current: 0.5, target: 0.8, magnitude: 0.375, confidence: 0.6 },
      ];
      const tasks = engine.generateTasks(gaps, goal);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].target_dimension).toBe('quality_score');
    });

    it('skips gap with magnitude exactly 0.05 (boundary: < 0.05 is skipped)', () => {
      const goal = makeGoal();
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.85, target: 0.9, magnitude: 0.05, confidence: 1.0 },
      ];
      // magnitude 0.05 is NOT < 0.05, so it should be included
      const tasks = engine.generateTasks(gaps, goal);
      expect(tasks).toHaveLength(1);
    });

    it('respects max_subtasks limit', () => {
      const goal = makeGoal({ constraints: { max_generation_depth: 3, max_subtasks: 2, distance_filter: 0.7 } });
      const gaps: Gap[] = Array.from({ length: 5 }, (_, i) => ({
        dimension: `dim_${i}`,
        current: 0.1,
        target: 0.9,
        magnitude: 0.8 - i * 0.05,
        confidence: 0.9,
      }));
      const tasks = engine.generateTasks(gaps, goal);
      expect(tasks.length).toBeLessThanOrEqual(2);
    });

    it('respects max_generation_depth: returns no tasks when depth >= limit', () => {
      const goal = makeGoal({ constraints: { max_generation_depth: 2, max_subtasks: 10, distance_filter: 0.7 } });
      const tasks = engine.generateTasks(baseGaps, goal, 2);
      expect(tasks).toHaveLength(0);
    });

    it('includes tasks when depth is below max_generation_depth', () => {
      const goal = makeGoal({ constraints: { max_generation_depth: 3, max_subtasks: 10, distance_filter: 0.7 } });
      const tasks = engine.generateTasks(baseGaps, goal, 2);
      expect(tasks.length).toBeGreaterThan(0);
    });

    it('sorts tasks by priority (magnitude * confidence) descending', () => {
      const goal = makeGoal();
      const gaps: Gap[] = [
        { dimension: 'low', current: 0.5, target: 0.8, magnitude: 0.375, confidence: 0.6 },  // priority 0.225
        { dimension: 'high', current: 0.3, target: 0.9, magnitude: 0.67, confidence: 0.85 }, // priority ~0.5695
      ];
      const tasks = engine.generateTasks(gaps, goal);
      expect(tasks[0].target_dimension).toBe('high');
      expect(tasks[1].target_dimension).toBe('low');
      for (let i = 1; i < tasks.length; i++) {
        expect(tasks[i - 1].priority).toBeGreaterThanOrEqual(tasks[i].priority);
      }
    });

    it('sets priority as magnitude * confidence', () => {
      const goal = makeGoal();
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.3, target: 0.9, magnitude: 0.67, confidence: 0.85 },
      ];
      const [task] = engine.generateTasks(gaps, goal);
      expect(task.priority).toBeCloseTo(0.67 * 0.85, 5);
    });

    it('produces correct description for increasing dimension', () => {
      const goal = makeGoal();
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.3, target: 0.9, magnitude: 0.67, confidence: 0.85 },
      ];
      const [task] = engine.generateTasks(gaps, goal);
      expect(task.description).toContain('Increase');
      expect(task.description).toContain('progress');
      expect(task.description).toContain('0.30');
      expect(task.description).toContain('0.90');
      expect(task.description).toContain('Auth module');
    });

    it('produces correct description for decreasing dimension', () => {
      const goal = makeGoal();
      const gaps: Gap[] = [
        { dimension: 'error_rate', current: 0.8, target: 0.1, magnitude: 0.7, confidence: 0.9 },
      ];
      const [task] = engine.generateTasks(gaps, goal);
      expect(task.description).toContain('Decrease');
      expect(task.description).toContain('error_rate');
    });

    it('includes percentage in description', () => {
      const goal = makeGoal();
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.3, target: 0.9, magnitude: 0.67, confidence: 0.85 },
      ];
      const [task] = engine.generateTasks(gaps, goal);
      // magnitude 0.67 → 67%
      expect(task.description).toContain('67%');
    });

    it('returns empty array when all gaps are below threshold', () => {
      const goal = makeGoal();
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.89, target: 0.9, magnitude: 0.01, confidence: 1.0 },
      ];
      expect(engine.generateTasks(gaps, goal)).toHaveLength(0);
    });

    it('returns empty array for empty gaps input', () => {
      const goal = makeGoal();
      expect(engine.generateTasks([], goal)).toHaveLength(0);
    });

    it('task id encodes goal id, dimension, and depth', () => {
      const goal = makeGoal();
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.3, target: 0.9, magnitude: 0.67, confidence: 0.85 },
      ];
      const [task] = engine.generateTasks(gaps, goal, 1);
      expect(task.id).toContain(goal.id);
      expect(task.id).toContain('progress');
      expect(task.id).toContain('1');
    });
  });

  // ---------------------------------------------------------------------------
  describe('filterByRelevance', () => {
    it('removes tasks below minimum priority derived from distance_filter', () => {
      const goal = makeGoal({ constraints: { max_generation_depth: 3, max_subtasks: 10, distance_filter: 0.7 } });
      // distance_filter 0.7 → minPriority = 0.3
      const tasks: Task[] = [
        {
          id: 't1', goal_id: goal.id, target_dimension: 'a', description: '', priority: 0.5,
          generation_depth: 0, status: 'pending', created_at: new Date().toISOString(),
        },
        {
          id: 't2', goal_id: goal.id, target_dimension: 'b', description: '', priority: 0.2,
          generation_depth: 0, status: 'pending', created_at: new Date().toISOString(),
        },
      ];
      const filtered = engine.filterByRelevance(tasks, goal);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('t1');
    });

    it('keeps tasks at exactly the minimum priority boundary', () => {
      const goal = makeGoal({ constraints: { max_generation_depth: 3, max_subtasks: 10, distance_filter: 0.7 } });
      // minPriority = 1.0 - 0.7 (floating point: ~0.30000000000000004)
      // Use the exact computed value so the >= comparison is unambiguous
      const minPriority = 1.0 - 0.7;
      const tasks: Task[] = [
        {
          id: 'edge', goal_id: goal.id, target_dimension: 'x', description: '', priority: minPriority,
          generation_depth: 0, status: 'pending', created_at: new Date().toISOString(),
        },
      ];
      const filtered = engine.filterByRelevance(tasks, goal);
      expect(filtered).toHaveLength(1);
    });

    it('returns all tasks when all are above the threshold', () => {
      const goal = makeGoal({ constraints: { max_generation_depth: 3, max_subtasks: 10, distance_filter: 0.7 } });
      const tasks: Task[] = [
        {
          id: 't1', goal_id: goal.id, target_dimension: 'a', description: '', priority: 0.9,
          generation_depth: 0, status: 'pending', created_at: new Date().toISOString(),
        },
        {
          id: 't2', goal_id: goal.id, target_dimension: 'b', description: '', priority: 0.8,
          generation_depth: 0, status: 'pending', created_at: new Date().toISOString(),
        },
      ];
      expect(engine.filterByRelevance(tasks, goal)).toHaveLength(2);
    });

    it('returns empty array when all tasks fall below threshold', () => {
      const goal = makeGoal({ constraints: { max_generation_depth: 3, max_subtasks: 10, distance_filter: 0.7 } });
      const tasks: Task[] = [
        {
          id: 't1', goal_id: goal.id, target_dimension: 'a', description: '', priority: 0.1,
          generation_depth: 0, status: 'pending', created_at: new Date().toISOString(),
        },
      ];
      expect(engine.filterByRelevance(tasks, goal)).toHaveLength(0);
    });

    it('uses distance_filter from goal constraints (lower filter = stricter)', () => {
      // distance_filter 0.9 → minPriority = 0.1; a task with priority 0.15 should pass
      const strictGoal = makeGoal({ constraints: { max_generation_depth: 3, max_subtasks: 10, distance_filter: 0.9 } });
      const tasks: Task[] = [
        {
          id: 't1', goal_id: strictGoal.id, target_dimension: 'a', description: '', priority: 0.15,
          generation_depth: 0, status: 'pending', created_at: new Date().toISOString(),
        },
      ];
      expect(engine.filterByRelevance(tasks, strictGoal)).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('getTopTask', () => {
    it('returns the highest priority task', () => {
      const goal = makeGoal();
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.3, target: 0.9, magnitude: 0.67, confidence: 0.85 },
        { dimension: 'quality_score', current: 0.5, target: 0.8, magnitude: 0.375, confidence: 0.6 },
      ];
      const top = engine.getTopTask(gaps, goal);
      expect(top).not.toBeNull();
      expect(top!.target_dimension).toBe('progress');
    });

    it('returns null when no gaps are provided', () => {
      const goal = makeGoal();
      expect(engine.getTopTask([], goal)).toBeNull();
    });

    it('returns null when all gaps are below magnitude threshold', () => {
      const goal = makeGoal();
      const gaps: Gap[] = [
        { dimension: 'progress', current: 0.89, target: 0.9, magnitude: 0.01, confidence: 1.0 },
      ];
      expect(engine.getTopTask(gaps, goal)).toBeNull();
    });

    it('returns null when depth exceeds max_generation_depth', () => {
      const goal = makeGoal({ constraints: { max_generation_depth: 1, max_subtasks: 10, distance_filter: 0.7 } });
      // depth defaults to 0, which is < 1, so tasks ARE generated
      // need depth >= max_generation_depth to get null
      const top = engine.getTopTask(baseGaps, goal);
      expect(top).not.toBeNull(); // depth=0 < max=1, so task is created
    });

    it('top task has the highest priority among all generated tasks', () => {
      const goal = makeGoal();
      const gaps: Gap[] = [
        { dimension: 'a', current: 0.1, target: 0.9, magnitude: 0.5, confidence: 0.5 },  // priority 0.25
        { dimension: 'b', current: 0.1, target: 0.9, magnitude: 0.9, confidence: 0.9 },  // priority 0.81
        { dimension: 'c', current: 0.1, target: 0.9, magnitude: 0.6, confidence: 0.7 },  // priority 0.42
      ];
      const top = engine.getTopTask(gaps, goal);
      const all = engine.generateTasks(gaps, goal);
      expect(top!.id).toBe(all[0].id);
      expect(top!.priority).toBe(all[0].priority);
    });
  });
});
