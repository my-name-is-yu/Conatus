import type {
  BrowserAutomationSessionRecord,
  BrowserAutomationSessionState,
} from "../store/index.js";
import {
  BrowserAutomationSessionRecordSchema,
  createRuntimeStorePaths,
  RuntimeJournal,
  type RuntimeStorePaths,
} from "../store/index.js";

export interface BrowserSessionScope {
  providerId: string;
  serviceKey: string;
  workspace: string;
  actorKey: string;
}

export class BrowserSessionStore {
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

  async load(sessionId: string): Promise<BrowserAutomationSessionRecord | null> {
    return this.journal.load(
      this.paths.browserSessionPath(sessionId),
      BrowserAutomationSessionRecordSchema,
    );
  }

  async list(): Promise<BrowserAutomationSessionRecord[]> {
    return this.journal.list(this.paths.browserSessionsDir, BrowserAutomationSessionRecordSchema);
  }

  async listPendingAuth(): Promise<BrowserAutomationSessionRecord[]> {
    return (await this.list())
      .filter((record) => record.state === "auth_required" || record.state === "expired")
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async findLatest(
    scope: BrowserSessionScope,
    states: BrowserAutomationSessionState[] = ["authenticated"],
  ): Promise<BrowserAutomationSessionRecord | null> {
    const matches = (await this.list())
      .filter((record) =>
        record.provider_id === scope.providerId
        && record.service_key === scope.serviceKey
        && record.workspace === scope.workspace
        && record.actor_key === scope.actorKey
        && states.includes(record.state)
        && !isExpired(record.expires_at)
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return matches[0] ?? null;
  }

  async upsert(record: BrowserAutomationSessionRecord): Promise<BrowserAutomationSessionRecord> {
    await this.ensureReady();
    const parsed = BrowserAutomationSessionRecordSchema.parse(record);
    await this.journal.save(this.paths.browserSessionPath(parsed.session_id), BrowserAutomationSessionRecordSchema, parsed);
    return parsed;
  }

  async recordAuthRequired(input: {
    sessionId: string;
    providerId: string;
    serviceKey: string;
    workspace: string;
    actorKey: string;
    failureMessage?: string | null;
    failureCode?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<BrowserAutomationSessionRecord> {
    const now = new Date().toISOString();
    const existing = await this.load(input.sessionId);
    return this.upsert({
      session_id: input.sessionId,
      provider_id: input.providerId,
      service_key: input.serviceKey,
      workspace: input.workspace,
      actor_key: input.actorKey,
      state: "auth_required",
      created_at: existing?.created_at ?? now,
      updated_at: now,
      last_auth_at: existing?.last_auth_at ?? null,
      expires_at: existing?.expires_at ?? null,
      last_failure_code: input.failureCode ?? existing?.last_failure_code ?? null,
      last_failure_message: input.failureMessage ?? existing?.last_failure_message ?? null,
      metadata: input.metadata ?? existing?.metadata,
    });
  }

  async recordAuthenticated(input: {
    sessionId: string;
    providerId: string;
    serviceKey: string;
    workspace: string;
    actorKey: string;
    expiresAt?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<BrowserAutomationSessionRecord> {
    const existing = await this.load(input.sessionId);
    const now = new Date().toISOString();
    return this.upsert({
      session_id: input.sessionId,
      provider_id: input.providerId,
      service_key: input.serviceKey,
      workspace: input.workspace,
      actor_key: input.actorKey,
      state: "authenticated",
      created_at: existing?.created_at ?? now,
      updated_at: now,
      last_auth_at: now,
      expires_at: input.expiresAt ?? existing?.expires_at ?? null,
      last_failure_code: null,
      last_failure_message: null,
      metadata: input.metadata ?? existing?.metadata,
    });
  }

  async markAuthenticated(sessionId: string, updates: {
    expiresAt?: string | null;
    metadata?: Record<string, unknown>;
  } = {}): Promise<BrowserAutomationSessionRecord | null> {
    const existing = await this.load(sessionId);
    if (!existing) return null;
    const now = new Date().toISOString();
    return this.upsert({
      ...existing,
      state: "authenticated",
      updated_at: now,
      last_auth_at: now,
      expires_at: updates.expiresAt ?? existing.expires_at ?? null,
      last_failure_code: null,
      last_failure_message: null,
      metadata: updates.metadata ?? existing.metadata,
    });
  }
}

function isExpired(expiresAt?: string | null): boolean {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}
