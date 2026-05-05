import type {
  RuntimeEvidenceEntry,
  RuntimeEvidenceResearchMemo,
} from "./evidence-types.js";

export interface RuntimeResearchMemoContext extends RuntimeEvidenceResearchMemo {
  entry_id: string;
  occurred_at: string;
  phase?: string;
}

export function summarizeEvidenceResearchMemos(
  entries: RuntimeEvidenceEntry[]
): RuntimeResearchMemoContext[] {
  const memos: RuntimeResearchMemoContext[] = [];
  for (const entry of entries) {
    for (const memo of entry.research ?? []) {
      memos.push({
        ...memo,
        entry_id: entry.id,
        occurred_at: entry.occurred_at,
        ...(entry.scope.phase ? { phase: entry.scope.phase } : {}),
      });
    }
  }
  return memos.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}
