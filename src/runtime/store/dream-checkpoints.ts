import type {
  RuntimeEvidenceDreamCheckpoint,
  RuntimeEvidenceEntry,
} from "./evidence-ledger.js";

export interface RuntimeDreamCheckpointContext extends RuntimeEvidenceDreamCheckpoint {
  entry_id: string;
  occurred_at: string;
  loop_index?: number;
  phase?: string;
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
        ...(entry.scope.loop_index !== undefined ? { loop_index: entry.scope.loop_index } : {}),
        ...(entry.scope.phase ? { phase: entry.scope.phase } : {}),
      });
    }
  }
  return checkpoints.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}
