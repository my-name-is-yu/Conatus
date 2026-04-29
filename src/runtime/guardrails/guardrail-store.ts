import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type {
  BackpressureSnapshot,
  CircuitBreakerRecord,
} from "../store/index.js";
import {
  BackpressureSnapshotSchema,
  CircuitBreakerRecordSchema,
  createRuntimeStorePaths,
  RuntimeJournal,
  type RuntimeStorePaths,
} from "../store/index.js";

export class GuardrailStore {
  private readonly paths: RuntimeStorePaths;
  private readonly journal: RuntimeJournal;

  constructor(runtimeRootOrPaths?: string | RuntimeStorePaths) {
    this.paths =
      typeof runtimeRootOrPaths === "string"
        ? createRuntimeStorePaths(runtimeRootOrPaths)
        : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.journal = new RuntimeJournal(this.paths);
  }

  async ensureReady(): Promise<void> {
    await this.journal.ensureReady();
  }

  async loadBreaker(key: string): Promise<CircuitBreakerRecord | null> {
    return this.journal.load(this.paths.guardrailBreakerPath(key), CircuitBreakerRecordSchema);
  }

  async saveBreaker(record: CircuitBreakerRecord): Promise<CircuitBreakerRecord> {
    await this.ensureReady();
    const parsed = CircuitBreakerRecordSchema.parse(record);
    await this.journal.save(this.paths.guardrailBreakerPath(parsed.key), CircuitBreakerRecordSchema, parsed);
    return parsed;
  }

  async listBreakers(): Promise<CircuitBreakerRecord[]> {
    return this.journal.list(this.paths.guardrailBreakersDir, CircuitBreakerRecordSchema);
  }

  async loadBackpressureSnapshot(): Promise<BackpressureSnapshot | null> {
    const snapshot = await this.journal.load(this.paths.backpressureSnapshotPath, BackpressureSnapshotSchema);
    return snapshot
      ? {
        ...snapshot,
        throttled: snapshot.throttled ?? [],
      }
      : null;
  }

  async saveBackpressureSnapshot(snapshot: BackpressureSnapshot): Promise<BackpressureSnapshot> {
    await this.ensureReady();
    const parsed = BackpressureSnapshotSchema.parse(snapshot);
    await this.journal.save(this.paths.backpressureSnapshotPath, BackpressureSnapshotSchema, parsed);
    return parsed;
  }

  async updateBackpressureSnapshot<T>(
    updater: (snapshot: BackpressureSnapshot) => Promise<{ snapshot: BackpressureSnapshot; result: T }> | { snapshot: BackpressureSnapshot; result: T },
  ): Promise<T> {
    return this.withBackpressureLock(async () => {
      const current = await this.loadBackpressureSnapshot() ?? {
        updated_at: new Date().toISOString(),
        active: [],
        throttled: [],
      };
      const updated = await updater(current);
      await this.saveBackpressureSnapshot(updated.snapshot);
      return updated.result;
    });
  }

  private backpressureLockPath(): string {
    return path.join(this.paths.guardrailsDir, "backpressure.lock");
  }

  private async withBackpressureLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = this.backpressureLockPath();
    const staleAfterMs = 30_000;

    for (;;) {
      try {
        await this.ensureReady();
        const handle = await fsp.open(lockPath, "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid, acquired_at: Date.now() }));
        try {
          return await fn();
        } finally {
          await handle.close();
          await fsp.unlink(lockPath).catch(() => undefined);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

        try {
          const stat = await fsp.stat(lockPath);
          if (Date.now() - stat.mtimeMs > staleAfterMs) {
            await fsp.unlink(lockPath).catch(() => undefined);
            continue;
          }
        } catch (staleErr) {
          if ((staleErr as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw staleErr;
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }
}
