import type { BrowserAutomationSessionRecord } from "../store/index.js";
import { BrowserSessionStore, type BrowserSessionScope } from "./browser-session-store.js";

export type BrowserSessionResolution =
  | {
    ok: true;
    sessionId?: string;
    record?: BrowserAutomationSessionRecord;
  }
  | {
    ok: false;
    code:
      | "browser_session_scope_required"
      | "browser_session_not_found"
      | "browser_session_stale"
      | "browser_session_scope_mismatch";
    summary: string;
    sessionId?: string;
  };

export class BrowserSessionResolver {
  constructor(private readonly store?: BrowserSessionStore) {}

  async resolveForWorkflow(input: {
    scope: BrowserSessionScope;
    sessionId?: string;
  }): Promise<BrowserSessionResolution> {
    return this.resolve({ ...input, implicitAllowed: true });
  }

  async resolveForState(input: {
    scope?: BrowserSessionScope;
    sessionId?: string;
  }): Promise<BrowserSessionResolution> {
    if (!input.sessionId && !input.scope) {
      return {
        ok: false,
        code: "browser_session_scope_required",
        summary: "browser_get_state requires sessionId or explicit service scope before reusing the latest browser session",
      };
    }
    return this.resolve({ ...input, implicitAllowed: Boolean(input.scope) });
  }

  private async resolve(input: {
    scope?: BrowserSessionScope;
    sessionId?: string;
    implicitAllowed: boolean;
  }): Promise<BrowserSessionResolution> {
    if (!this.store) {
      return input.sessionId ? { ok: true, sessionId: input.sessionId } : { ok: true };
    }

    if (input.sessionId) {
      const record = await this.store.load(input.sessionId);
      if (!record) {
        return {
          ok: false,
          code: "browser_session_not_found",
          summary: `Browser session ${input.sessionId} was not found`,
          sessionId: input.sessionId,
        };
      }
      if (input.scope && !sameScope(record, input.scope)) {
        return {
          ok: false,
          code: "browser_session_scope_mismatch",
          summary: `Browser session ${input.sessionId} does not match the requested browser scope`,
          sessionId: input.sessionId,
        };
      }
      const staleReason = staleSessionReason(record);
      if (staleReason) {
        return {
          ok: false,
          code: "browser_session_stale",
          summary: `Browser session ${input.sessionId} is not reusable: ${staleReason}`,
          sessionId: input.sessionId,
        };
      }
      return { ok: true, sessionId: record.session_id, record };
    }

    if (!input.implicitAllowed || !input.scope) {
      return { ok: true };
    }

    const latest = await this.store.findLatest(input.scope, ["authenticated"]);
    return latest
      ? { ok: true, sessionId: latest.session_id, record: latest }
      : { ok: true };
  }
}

function sameScope(record: BrowserAutomationSessionRecord, scope: BrowserSessionScope): boolean {
  return record.provider_id === scope.providerId
    && record.service_key === scope.serviceKey
    && record.workspace === scope.workspace
    && record.actor_key === scope.actorKey;
}

function staleSessionReason(record: BrowserAutomationSessionRecord): string | null {
  if (record.state !== "authenticated") return record.state;
  if (!record.expires_at) return null;
  const expiresAtMs = Date.parse(record.expires_at);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now() ? "expired" : null;
}
