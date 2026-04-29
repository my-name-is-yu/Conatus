import type { BackpressureSnapshot } from "../store/index.js";
import { GuardrailStore } from "./guardrail-store.js";

export interface BackpressureControllerOptions {
  maxConcurrentPerProvider?: number;
  maxConcurrentPerService?: number;
  leaseTtlMs?: number;
  now?: () => Date;
}

export interface BackpressureLease {
  providerId: string;
  serviceKey: string;
  runKey: string;
}

export class BackpressureController {
  private readonly maxConcurrentPerProvider: number;
  private readonly maxConcurrentPerService: number;
  private readonly leaseTtlMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: GuardrailStore,
    options: BackpressureControllerOptions = {},
  ) {
    this.maxConcurrentPerProvider = options.maxConcurrentPerProvider ?? 2;
    this.maxConcurrentPerService = options.maxConcurrentPerService ?? 1;
    this.leaseTtlMs = options.leaseTtlMs ?? 10 * 60_000;
    this.now = options.now ?? (() => new Date());
  }

  async acquire(lease: BackpressureLease): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.store.updateBackpressureSnapshot<{ ok: true } | { ok: false; reason: string }>((snapshot) => {
      const active = this.pruneExpired(snapshot.active);
      const providerActive = active.filter((entry) => entry.provider_id === lease.providerId);
      if (providerActive.length >= this.maxConcurrentPerProvider) {
        return this.reject(snapshot, lease, `provider concurrency limit reached (${this.maxConcurrentPerProvider})`, active);
      }
      const serviceActive = providerActive.filter((entry) => entry.service_key === lease.serviceKey);
      if (serviceActive.length >= this.maxConcurrentPerService) {
        return this.reject(snapshot, lease, `service concurrency limit reached (${this.maxConcurrentPerService})`, active);
      }

      return {
        snapshot: {
          updated_at: this.now().toISOString(),
          active: [
            ...active,
            {
              provider_id: lease.providerId,
              service_key: lease.serviceKey,
              run_key: lease.runKey,
              acquired_at: this.now().toISOString(),
            },
          ],
          throttled: snapshot.throttled ?? [],
        },
        result: { ok: true as const },
      };
    });
  }

  async release(runKey: string): Promise<void> {
    await this.store.updateBackpressureSnapshot(async (snapshot) => ({
      snapshot: {
        updated_at: this.now().toISOString(),
        active: this.pruneExpired(snapshot.active).filter((entry) => entry.run_key !== runKey),
        throttled: snapshot.throttled ?? [],
      },
      result: undefined,
    }));
  }

  async snapshot(): Promise<BackpressureSnapshot> {
    const stored = await this.store.loadBackpressureSnapshot();
    return stored ?? {
      updated_at: this.now().toISOString(),
      active: [],
      throttled: [],
    };
  }

  private reject(
    snapshot: BackpressureSnapshot,
    lease: BackpressureLease,
    reason: string,
    active = this.pruneExpired(snapshot.active),
  ): { snapshot: BackpressureSnapshot; result: { ok: false; reason: string } } {
    const throttled = [
      ...(snapshot.throttled ?? []),
      {
        provider_id: lease.providerId,
        service_key: lease.serviceKey,
        reason,
        at: this.now().toISOString(),
      },
    ].slice(-20);
    return {
      snapshot: {
        updated_at: this.now().toISOString(),
        active,
        throttled,
      },
      result: { ok: false as const, reason },
    };
  }

  private pruneExpired(active: BackpressureSnapshot["active"]): BackpressureSnapshot["active"] {
    const now = this.now().getTime();
    return active.filter((entry) => {
      const acquiredAt = Date.parse(entry.acquired_at);
      return Number.isFinite(acquiredAt) && now - acquiredAt <= this.leaseTtlMs;
    });
  }
}
