import * as fsp from "node:fs/promises";
import * as path from "node:path";

export interface WALIntent {
  op: string;
  data: unknown;
  ts: string;
}

export interface WALCommit {
  op: "commit";
  ref_ts: string;
  ts: string;
}

export interface WALCompactionStart {
  op: "compaction_start";
  ts: string;
}

export interface WALCompactionComplete {
  op: "compaction_complete";
  ref_ts: string;
  ts: string;
}

type WALRecord = WALIntent | WALCommit | WALCompactionStart | WALCompactionComplete;

function walPath(goalId: string, baseDir: string): string {
  return path.join(baseDir, "goals", goalId, "wal.jsonl");
}

export async function appendWALRecord(
  goalId: string,
  baseDir: string,
  record: WALRecord
): Promise<void> {
  const filePath = walPath(goalId, baseDir);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, JSON.stringify(record) + "
", "utf-8");
}

export async function readWAL(
  goalId: string,
  baseDir: string
): Promise<WALRecord[]> {
  const filePath = walPath(goalId, baseDir);
  let content: string;
  try {
    content = await fsp.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return content
    .split("
")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as WALRecord);
}

export async function replayWAL(
  goalId: string,
  baseDir: string,
  applyFn: (intent: WALIntent) => Promise<void>
): Promise<number> {
  const records = await readWAL(goalId, baseDir);
  const committed = new Set<string>();
  for (const r of records) {
    if (r.op === "commit") committed.add((r as WALCommit).ref_ts);
  }
  let count = 0;
  for (const r of records) {
    if (r.op !== "commit" && r.op !== "compaction_start" && r.op !== "compaction_complete") {
      const intent = r as WALIntent;
      if (!committed.has(intent.ts)) {
        await applyFn(intent);
        count++;
      }
    }
  }
  return count;
}

export async function compactWAL(
  goalId: string,
  baseDir: string
): Promise<void> {
  const records = await readWAL(goalId, baseDir);

  // Check for incomplete compaction (compaction_start without compaction_complete)
  let pendingCompactionTs: string | null = null;
  for (const r of records) {
    if (r.op === "compaction_start") {
      pendingCompactionTs = (r as WALCompactionStart).ts;
    } else if (r.op === "compaction_complete") {
      pendingCompactionTs = null;
    }
  }

  const compactionStartTs = new Date().toISOString();
  await appendWALRecord(goalId, baseDir, {
    op: "compaction_start",
    ts: compactionStartTs,
  });

  // Keep only uncommitted intents (those without matching commits)
  const committed = new Set<string>();
  for (const r of records) {
    if (r.op === "commit") committed.add((r as WALCommit).ref_ts);
  }
  const remaining: WALRecord[] = [];
  for (const r of records) {
    if (r.op === "compaction_start" || r.op === "compaction_complete") continue;
    if (r.op === "commit") continue;
    const intent = r as WALIntent;
    if (!committed.has(intent.ts)) remaining.push(intent);
  }

  // Rewrite WAL with only uncommitted intents
  const filePath = walPath(goalId, baseDir);
  await fsp.writeFile(
    filePath,
    remaining.map((r) => JSON.stringify(r)).join("
") + (remaining.length > 0 ? "
" : ""),
    "utf-8"
  );

  await appendWALRecord(goalId, baseDir, {
    op: "compaction_complete",
    ref_ts: compactionStartTs,
    ts: new Date().toISOString(),
  });

  void pendingCompactionTs; // handled implicitly by re-running compaction
}

export async function truncateWAL(
  goalId: string,
  baseDir: string
): Promise<void> {
  const filePath = walPath(goalId, baseDir);
  try {
    await fsp.writeFile(filePath, "", "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}
