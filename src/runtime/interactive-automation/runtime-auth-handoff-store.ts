import { randomUUID } from "node:crypto";
import type {
  RuntimeAuthHandoffRecord,
  RuntimeAuthHandoffState,
  RuntimeControlActor,
  RuntimeControlReplyTarget,
} from "../store/index.js";
import {
  createRuntimeStorePaths,
  RuntimeAuthHandoffRecordSchema,
  RuntimeJournal,
  type RuntimeStorePaths,
} from "../store/index.js";
import type { BrowserSessionScope } from "./browser-session-store.js";
import type { z } from "zod";

const ACTIVE_STATES = new Set<RuntimeAuthHandoffState>([
  "requested",
  "pending_operator",
  "in_progress",
  "blocked",
]);
const RuntimeAuthHandoffJournalSchema = RuntimeAuthHandoffRecordSchema as z.ZodType<RuntimeAuthHandoffRecord>;

export interface RuntimeAuthHandoffCreateInput {
  providerId: string;
  serviceKey: string;
  workspace: string;
  actorKey: string;
  state?: Extract<RuntimeAuthHandoffState, "requested" | "pending_operator" | "blocked">;
  browserSessionId?: string | null;
  resumableSessionId?: string | null;
  replyTarget?: RuntimeControlReplyTarget | null;
  requestedBy?: RuntimeControlActor | null;
  expiresAt?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  taskSummary: string;
  evidenceRefs?: RuntimeAuthHandoffRecord["evidence_refs"];
}

export class RuntimeAuthHandoffStore {
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

  async load(handoffId: string): Promise<RuntimeAuthHandoffRecord | null> {
    return this.journal.load(this.paths.authHandoffPath(handoffId), RuntimeAuthHandoffJournalSchema);
  }

  async list(): Promise<RuntimeAuthHandoffRecord[]> {
    return this.journal.list(this.paths.authHandoffsDir, RuntimeAuthHandoffJournalSchema);
  }

  async listActive(scope?: BrowserSessionScope): Promise<RuntimeAuthHandoffRecord[]> {
    return (await this.list())
      .filter((record) =>
        ACTIVE_STATES.has(record.state)
        && (!scope
          || (record.provider_id === scope.providerId
            && record.service_key === scope.serviceKey
            && record.workspace === scope.workspace
            && record.actor_key === scope.actorKey))
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async findLatestActive(scope: BrowserSessionScope): Promise<RuntimeAuthHandoffRecord | null> {
    return (await this.listActive(scope))[0] ?? null;
  }

  async upsert(record: RuntimeAuthHandoffRecord): Promise<RuntimeAuthHandoffRecord> {
    await this.ensureReady();
    const parsed = RuntimeAuthHandoffRecordSchema.parse(record);
    await this.journal.save(this.paths.authHandoffPath(parsed.handoff_id), RuntimeAuthHandoffJournalSchema, parsed);
    return parsed;
  }

  async createPending(input: RuntimeAuthHandoffCreateInput): Promise<RuntimeAuthHandoffRecord> {
    const now = new Date().toISOString();
    const scope: BrowserSessionScope = {
      providerId: input.providerId,
      serviceKey: input.serviceKey,
      workspace: input.workspace,
      actorKey: input.actorKey,
    };
    const superseded = await this.supersedeActive(scope, now);
    const latestSuperseded = superseded[0] ?? null;
    const handoff: RuntimeAuthHandoffRecord = {
      schema_version: "runtime-auth-handoff-v1",
      handoff_id: randomUUID(),
      provider_id: input.providerId,
      service_key: input.serviceKey,
      workspace: input.workspace,
      actor_key: input.actorKey,
      state: input.state ?? "pending_operator",
      requested_at: now,
      updated_at: now,
      expires_at: input.expiresAt ?? null,
      completed_at: null,
      browser_session_id: input.browserSessionId ?? null,
      resumable_session_id: input.resumableSessionId ?? null,
      supersedes_handoff_id: latestSuperseded?.handoff_id ?? null,
      superseded_by_handoff_id: null,
      reply_target: input.replyTarget ?? null,
      requested_by: input.requestedBy ?? null,
      failure_code: input.failureCode ?? null,
      failure_message: input.failureMessage ?? null,
      resume_hint: {
        tool_name: "browser_run_workflow",
        task_summary: input.taskSummary,
      },
      evidence_refs: input.evidenceRefs ?? [],
    };
    const created = await this.upsert(handoff);
    for (const record of superseded) {
      await this.upsert({
        ...record,
        superseded_by_handoff_id: created.handoff_id,
      });
    }
    return created;
  }

  async transition(
    handoffId: string,
    state: RuntimeAuthHandoffState,
    updates: Partial<Pick<RuntimeAuthHandoffRecord,
      "browser_session_id" | "resumable_session_id" | "failure_code" | "failure_message" | "evidence_refs"
    >> = {},
  ): Promise<RuntimeAuthHandoffRecord | null> {
    const existing = await this.load(handoffId);
    if (!existing) return null;
    const now = new Date().toISOString();
    return this.upsert({
      ...existing,
      ...updates,
      state,
      updated_at: now,
      completed_at: state === "completed" ? now : existing.completed_at ?? null,
    });
  }

  async transitionLatestActive(
    scope: BrowserSessionScope,
    state: RuntimeAuthHandoffState,
    updates: Partial<Pick<RuntimeAuthHandoffRecord,
      "browser_session_id" | "resumable_session_id" | "failure_code" | "failure_message" | "evidence_refs"
    >> = {},
  ): Promise<RuntimeAuthHandoffRecord | null> {
    const latest = await this.findLatestActive(scope);
    if (!latest) return null;
    return this.transition(latest.handoff_id, state, updates);
  }

  private async supersedeActive(
    scope: BrowserSessionScope,
    now: string,
  ): Promise<RuntimeAuthHandoffRecord[]> {
    const active = await this.listActive(scope);
    const superseded = active.map((record) => ({
      ...record,
      state: "superseded" as const,
      updated_at: now,
    }));
    for (const record of superseded) {
      await this.upsert(record);
    }
    return superseded;
  }
}
