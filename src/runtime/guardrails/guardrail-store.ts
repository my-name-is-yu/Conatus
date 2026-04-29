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
}
