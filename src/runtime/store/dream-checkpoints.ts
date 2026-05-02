import type {
  RuntimeEvidenceDreamCheckpoint,
  RuntimeEvidenceEntry,
} from "./evidence-ledger.js";

export interface RuntimeDreamCheckpointContext extends RuntimeEvidenceDreamCheckpoint {
  entry_id: string;
  occurred_at: string;
  goal_id?: string;
  run_id?: string;
  loop_index?: number;
  phase?: string;
  planning_context_status?: "active" | "partially_retracted";
}

export function summarizeEvidenceDreamCheckpoints(
  entries: RuntimeEvidenceEntry[]
): RuntimeDreamCheckpointContext[] {
  const checkpoints: RuntimeDreamCheckpointContext[] = [];
  for (const entry of entries) {
    for (const checkpoint of entry.dream_checkpoints ?? []) {
      checkpoints.push({
        ...checkpoint,
        entry_id: entry.id,
        occurred_at: entry.occurred_at,
        ...(entry.scope.goal_id ? { goal_id: entry.scope.goal_id } : {}),
        ...(entry.scope.run_id ? { run_id: entry.scope.run_id } : {}),
        ...(entry.scope.loop_index !== undefined ? { loop_index: entry.scope.loop_index } : {}),
        ...(entry.scope.phase ? { phase: entry.scope.phase } : {}),
      });
    }
  }
  return checkpoints.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}
