/**
 * user-prompt hook
 *
 * Reads UserPromptSubmit JSON from stdin, checks prompt relevance to active goals,
 * injects priority context, and optionally blocks prompts unrelated to goals when
 * strict_goal_alignment is enabled.
 *
 * Exit codes:
 *   0 — pass (prompt forwarded, possibly augmented)
 *   2 — block (strict mode, unrelated prompt)
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { StateManager } from '../state/manager.js';
import { TaskGenerationEngine } from '../engines/task-generation.js';
import { GapAnalysisEngine } from '../engines/gap-analysis.js';
import type { Goal } from '../state/models.js';
import { debug } from '../debug.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface MotiveConfig {
  strict_goal_alignment?: boolean;
}

function loadConfig(configPath: string): MotiveConfig {
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, 'utf-8');
    // Simple YAML key: value parsing (no external dep)
    const config: MotiveConfig = {};
    for (const line of raw.split('\n')) {
      const m = line.match(/^strict_goal_alignment\s*:\s*(true|false)/i);
      if (m) config.strict_goal_alignment = m[1].toLowerCase() === 'true';
    }
    return config;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Goal relevance matching
// ---------------------------------------------------------------------------

/**
 * Returns true when the prompt contains at least one keyword from the goal's
 * title or description (case-insensitive, word-boundary-aware).
 */
export function isRelatedToGoal(prompt: string, goal: Goal): boolean {
  const lower = prompt.toLowerCase();
  const text = `${goal.title} ${goal.description}`.toLowerCase();
  // Extract non-trivial words (3+ chars)
  const words = text.match(/\b\w{3,}\b/g) ?? [];
  return words.some(word => lower.includes(word));
}

/**
 * Returns the first active goal related to the prompt, or null.
 */
export function findRelatedGoal(prompt: string, goals: Goal[]): Goal | null {
  return goals.find(g => isRelatedToGoal(prompt, g)) ?? null;
}

// ---------------------------------------------------------------------------
// Context injection
// ---------------------------------------------------------------------------

/**
 * Build a short context string summarising the top goal and its top task.
 */
export function buildInjectedContext(goal: Goal): string {
  const gapEngine = new GapAnalysisEngine();
  const taskEngine = new TaskGenerationEngine();
  const gaps = gapEngine.computeGaps(goal);
  const topTask = taskEngine.getTopTask(gaps, goal);

  const progress = goal.state_vector.progress?.value;
  const progressStr = progress !== undefined ? ` (progress: ${(progress * 100).toFixed(0)}%)` : '';

  const lines: string[] = [
    '',
    '[Motive] Active goal context:',
    `  Goal: ${goal.title}${progressStr}`,
  ];

  if (goal.deadline) {
    lines.push(`  Deadline: ${goal.deadline}`);
  }

  if (topTask) {
    lines.push(`  Suggested next task: ${topTask.description}`);
  }

  return lines.join('\n');
}

/**
 * Build a gentle reminder when no related goal was found and strict mode is off.
 */
export function buildReminderContext(goals: Goal[]): string {
  if (goals.length === 0) return '';
  const top = goals.reduce((a, b) => (a.motivation_score >= b.motivation_score ? a : b));
  return `\n[Motive] Reminder: current top goal is "${top.title}". Consider whether this prompt advances it.`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function run(
  input: { prompt: string },
  projectRoot: string,
): { output: { prompt: string }; exitCode: 0 | 2; stderrMessage?: string } {
  const truncatedPrompt = input.prompt.slice(0, 120) + (input.prompt.length > 120 ? '...' : '');
  debug('user-prompt', 'entry', { prompt_preview: truncatedPrompt });

  const manager = new StateManager(projectRoot);
  const config = loadConfig(manager.configPath);
  const goals = manager.loadActiveGoals().filter(g => g.status === 'active');
  debug('user-prompt', 'active goals loaded', { count: goals.length, strict_mode: config.strict_goal_alignment ?? false });

  const relatedGoal = findRelatedGoal(input.prompt, goals);
  debug('user-prompt', 'priority scoring result', { related_goal: relatedGoal?.id ?? null, related_goal_title: relatedGoal?.title ?? null });

  if (relatedGoal) {
    const context = buildInjectedContext(relatedGoal);
    const task = new TaskGenerationEngine().getTopTask(new GapAnalysisEngine().computeGaps(relatedGoal), relatedGoal);
    debug('user-prompt', 'task generated', { goal_id: relatedGoal.id, top_task: task?.description ?? null });
    debug('user-prompt', 'exit', { action: 'pass_with_context', exit_code: 0 });
    return {
      output: { prompt: input.prompt + context },
      exitCode: 0,
    };
  }

  // No related goal found
  if (config.strict_goal_alignment) {
    const goalList = goals.map(g => `"${g.title}"`).join(', ');
    debug('user-prompt', 'exit', { action: 'block_strict_mode', exit_code: 2, active_goals: goalList });
    return {
      output: { prompt: input.prompt },
      exitCode: 2,
      stderrMessage:
        `[Motive] Prompt blocked: strict_goal_alignment is enabled. ` +
        `Active goals: ${goalList || '(none)'}. ` +
        `Please relate your prompt to an active goal or disable strict mode.`,
    };
  }

  // Pass through with gentle reminder
  const reminder = buildReminderContext(goals);
  debug('user-prompt', 'exit', { action: 'pass_with_reminder', exit_code: 0 });
  return {
    output: { prompt: input.prompt + reminder },
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/* c8 ignore start */
if (process.argv[1] && process.argv[1].endsWith('user-prompt.js')) {
  const raw = readFileSync('/dev/stdin', 'utf-8');
  const input = JSON.parse(raw) as { prompt: string };
  const projectRoot = process.env.MOTIVE_PROJECT_ROOT ?? process.cwd();
  const { output, exitCode, stderrMessage } = run(input, projectRoot);
  if (stderrMessage) process.stderr.write(stderrMessage + '\n');
  process.stdout.write(JSON.stringify(output) + '\n');
  process.exit(exitCode);
}
/* c8 ignore end */
