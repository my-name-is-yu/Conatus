import type { AutomationFailureCode } from "../interactive-automation/types.js";
import type { CircuitBreakerRecord } from "../store/index.js";
import { GuardrailStore } from "./guardrail-store.js";

export interface CircuitBreakerPolicy {
  failureThreshold: number;
  cooldownMs: number;
}

export interface CircuitBreakerPolicies {
  default: CircuitBreakerPolicy;
  byFailureCode?: Partial<Record<AutomationFailureCode, CircuitBreakerPolicy>>;
}

const DEFAULT_POLICIES: CircuitBreakerPolicies = {
  default: { failureThreshold: 3, cooldownMs: 5 * 60_000 },
  byFailureCode: {
    rate_limited: { failureThreshold: 2, cooldownMs: 15 * 60_000 },
    site_blocked: { failureThreshold: 2, cooldownMs: 60 * 60_000 },
    provider_unavailable: { failureThreshold: 2, cooldownMs: 5 * 60_000 },
  },
};

export interface CircuitBreakerDecision {
  allowed: boolean;
  state: CircuitBreakerRecord["state"];
  reason?: string;
}

export class CircuitBreakerController {
  constructor(
    private readonly store: GuardrailStore,
    private readonly policies: CircuitBreakerPolicies = DEFAULT_POLICIES,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async beforeRun(providerId: string, serviceKey: string): Promise<CircuitBreakerDecision> {
    const key = breakerKey(providerId, serviceKey);
    const current = await this.store.loadBreaker(key);
    if (!current || current.state === "closed") {
      return { allowed: true, state: current?.state ?? "closed" };
    }

    if (current.state === "paused") {
      return { allowed: false, state: "paused", reason: "provider is manually paused" };
    }

    if (current.state === "open") {
      const cooldownUntil = current.cooldown_until ? Date.parse(current.cooldown_until) : 0;
      if (cooldownUntil > this.now().getTime()) {
        return {
          allowed: false,
          state: "open",
          reason: `circuit breaker open until ${current.cooldown_until}`,
        };
      }

      const halfOpen: CircuitBreakerRecord = {
        ...current,
        state: "half_open",
        updated_at: this.now().toISOString(),
      };
      await this.store.saveBreaker(halfOpen);
      return { allowed: true, state: "half_open" };
    }

    return { allowed: true, state: current.state };
  }

  async recordSuccess(providerId: string, serviceKey: string): Promise<void> {
    const key = breakerKey(providerId, serviceKey);
    const current = await this.store.loadBreaker(key);
    if (!current) return;
    await this.store.saveBreaker({
      ...current,
      state: "closed",
      failure_count: 0,
      last_failure_code: null,
      last_failure_message: null,
      last_failure_at: null,
      opened_at: null,
      cooldown_until: null,
      updated_at: this.now().toISOString(),
    });
  }

  async recordFailure(input: {
    providerId: string;
    serviceKey: string;
    failureCode: AutomationFailureCode;
    failureMessage?: string | null;
  }): Promise<CircuitBreakerRecord> {
    const key = breakerKey(input.providerId, input.serviceKey);
    const current = await this.store.loadBreaker(key);
    const policy = this.policies.byFailureCode?.[input.failureCode] ?? this.policies.default;
    const failureCount = (current?.failure_count ?? 0) + 1;
    const opened = failureCount >= policy.failureThreshold;
    const nowIso = this.now().toISOString();
    return this.store.saveBreaker({
      key,
      provider_id: input.providerId,
      service_key: input.serviceKey,
      state: opened ? "open" : "closed",
      failure_count: failureCount,
      last_failure_code: input.failureCode,
      last_failure_message: input.failureMessage ?? null,
      last_failure_at: nowIso,
      opened_at: opened ? nowIso : current?.opened_at ?? null,
      cooldown_until: opened ? new Date(this.now().getTime() + policy.cooldownMs).toISOString() : null,
      updated_at: nowIso,
    });
  }
}

export function breakerKey(providerId: string, serviceKey: string): string {
  return `${providerId}::${serviceKey}`;
}
