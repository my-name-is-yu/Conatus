import {
  RuntimeSafePauseRecordSchema,
  type RuntimeSafePauseCheckpoint,
  type RuntimeSafePauseRecord,
} from "./runtime-schemas.js";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import { RuntimeJournal } from "./runtime-journal.js";

export interface RuntimeSafePauseRequestInput {
  goalId: string;
  reason?: string;
  requestedBy?: string;
  now?: string;
}

export interface RuntimeSafePauseCheckpointInput {
  goalId: string;
  checkpoint: RuntimeSafePauseCheckpoint;
  now?: string;
}

export class RuntimeSafePauseStore {
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

  async load(goalId: string): Promise<RuntimeSafePauseRecord | null> {
    return this.journal.load(this.paths.safePausePath(goalId), RuntimeSafePauseRecordSchema);
  }

  async list(): Promise<RuntimeSafePauseRecord[]> {
    return this.journal.list(this.paths.safePausesDir, RuntimeSafePauseRecordSchema);
  }

  async requestPause(input: RuntimeSafePauseRequestInput): Promise<RuntimeSafePauseRecord> {
    const now = input.now ?? new Date().toISOString();
    const existing = await this.load(input.goalId);
    return this.save({
      schema_version: "runtime-safe-pause-v1",
      goal_id: input.goalId,
      state: "pause_requested",
      requested_at: existing?.requested_at ?? now,
      updated_at: now,
      requested_by: input.requestedBy,
      reason: input.reason,
      checkpoint: existing?.checkpoint,
    });
  }

  async markPaused(input: RuntimeSafePauseCheckpointInput): Promise<RuntimeSafePauseRecord> {
    const now = input.now ?? new Date().toISOString();
    const existing = await this.load(input.goalId);
    return this.save({
      schema_version: "runtime-safe-pause-v1",
      goal_id: input.goalId,
      state: "paused",
      requested_at: existing?.requested_at ?? now,
      paused_at: existing?.paused_at ?? now,
      updated_at: now,
      requested_by: existing?.requested_by,
      reason: existing?.reason,
      checkpoint: input.checkpoint,
    });
  }

  async markResumed(goalId: string, now = new Date().toISOString()): Promise<RuntimeSafePauseRecord> {
    const existing = await this.load(goalId);
    return this.save({
      schema_version: "runtime-safe-pause-v1",
      goal_id: goalId,
      state: "resumed",
      requested_at: existing?.requested_at,
      paused_at: existing?.paused_at,
      resumed_at: now,
      updated_at: now,
      requested_by: existing?.requested_by,
      reason: existing?.reason,
      checkpoint: existing?.checkpoint,
    });
  }

  async markEmergencyStopped(goalId: string, reason: string, now = new Date().toISOString()): Promise<RuntimeSafePauseRecord> {
    const existing = await this.load(goalId);
    return this.save({
      schema_version: "runtime-safe-pause-v1",
      goal_id: goalId,
      state: "emergency_stopped",
      requested_at: existing?.requested_at,
      paused_at: existing?.paused_at,
      completed_at: now,
      updated_at: now,
      requested_by: existing?.requested_by,
      reason,
      checkpoint: existing?.checkpoint,
    });
  }

  async markCompleted(goalId: string, now = new Date().toISOString()): Promise<RuntimeSafePauseRecord> {
    const existing = await this.load(goalId);
    return this.save({
      schema_version: "runtime-safe-pause-v1",
      goal_id: goalId,
      state: "completed",
      requested_at: existing?.requested_at,
      paused_at: existing?.paused_at,
      completed_at: now,
      updated_at: now,
      requested_by: existing?.requested_by,
      reason: existing?.reason,
      checkpoint: existing?.checkpoint,
    });
  }

  async save(record: RuntimeSafePauseRecord): Promise<RuntimeSafePauseRecord> {
    const parsed = RuntimeSafePauseRecordSchema.parse(record);
    await this.journal.save(this.paths.safePausePath(parsed.goal_id), RuntimeSafePauseRecordSchema, parsed);
    return parsed;
  }
}
