import { StateManager } from '../state/manager.js';
import { GapAnalysisEngine } from '../engines/gap-analysis.js';
import { PriorityScoringEngine } from '../engines/priority-scoring.js';
import { ContextInjector } from '../context/injector.js';
import { debug } from '../debug.js';

export interface SessionStartInput {
  session_id?: string;
  cwd?: string;
}

export interface SessionStartResult {
  goalsProcessed: number;
  contextPath: string;
}

export async function processSessionStart(
  input: SessionStartInput,
  projectRoot?: string
): Promise<SessionStartResult> {
  const t0 = Date.now();
  const root = input.cwd ?? projectRoot ?? process.cwd();
  debug('session-start', 'entry', { session_id: input.session_id, root });

  const manager = new StateManager(root);
  const state = manager.init();
  debug('session-start', 'state loaded/created', { session_id: state.session_id, active_goals: state.active_goal_ids.length });

  // Update session_id if provided
  if (input.session_id) {
    state.session_id = input.session_id;
  }

  const gapEngine = new GapAnalysisEngine();
  const scoringEngine = new PriorityScoringEngine();

  const goals = manager.loadActiveGoals();
  debug('session-start', 'goals found', { count: goals.length, ids: goals.map(g => g.id) });

  for (const goal of goals) {
    // Recompute gaps
    goal.gaps = gapEngine.computeGaps(goal);
    debug('session-start', 'gap analysis result', { goal_id: goal.id, gaps_count: goal.gaps.length, max_magnitude: goal.gaps[0]?.magnitude ?? 0 });

    // Compute motivation score and breakdown
    const score = scoringEngine.motivationScore(goal, goal.gaps);
    const dl = scoringEngine.deadlineScore(goal);
    const ds = scoringEngine.dissatisfactionScore(goal.gaps);
    const op = scoringEngine.opportunityScore([]);

    goal.motivation_score = score;
    goal.motivation_breakdown = {
      deadline_pressure: dl,
      dissatisfaction: ds,
      opportunity: op,
    };

    manager.saveGoal(goal);
  }

  manager.saveState(state);

  // Generate context injection file
  const injector = new ContextInjector(manager);
  const contextPath = injector.write();

  const elapsed = Date.now() - t0;
  debug('session-start', 'exit', { goals_processed: goals.length, context_path: contextPath, elapsed_ms: elapsed });

  return {
    goalsProcessed: goals.length,
    contextPath,
  };
}

async function main(): Promise<void> {
  let rawInput = '';
  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  let input: SessionStartInput = {};
  if (rawInput.trim()) {
    try {
      input = JSON.parse(rawInput) as SessionStartInput;
    } catch {
      // Unparseable stdin — treat as empty input
    }
  }

  await processSessionStart(input);
  process.exit(0);
}

// Run main only when this module is the entry point
if (
  process.argv[1] &&
  (process.argv[1].endsWith('session-start.ts') ||
    process.argv[1].endsWith('session-start.js'))
) {
  main().catch(() => process.exit(1));
}
