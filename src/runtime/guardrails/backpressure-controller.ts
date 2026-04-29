import type { BackpressureSnapshot } from "../store/index.js";
import { GuardrailStore } from "./guardrail-store.js";

export interface BackpressureControllerOptions {
  maxConcurrentPerProvider?: number;
  maxConcurrentPerService?: number;
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
  private readonly now: () => Date;
  private readonly active = new Map<string, BackpressureLease>();
  private readonly throttled: Array<{ providerId: string; serviceKey: string; reason: string; at: string }> = [];

  constructor(
    private readonly store: GuardrailStore,
    options: BackpressureControllerOptions = {},
  ) {
    this.maxConcurrentPerProvider = options.maxConcurrentPerProvider ?? 2;
    this.maxConcurrentPerService = options.maxConcurrentPerService ?? 1;
    this.now = options.now ?? (() => new Date());
  }

  async acquire(lease: BackpressureLease): Promise<{ ok: true } | { ok: false; reason: string }> {
    const providerActive = [...this.active.values()].filter((entry) => entry.providerId === lease.providerId);
    if (providerActive.length >= this.maxConcurrentPerProvider) {
      return this.reject(lease, `provider concurrency limit reached (${this.maxConcurrentPerProvider})`);
    }
    const serviceActive = providerActive.filter((entry) => entry.serviceKey === lease.serviceKey);
    if (serviceActive.length >= this.maxConcurrentPerService) {
      return this.reject(lease, `service concurrency limit reached (${this.maxConcurrentPerService})`);
    }

    this.active.set(lease.runKey, lease);
    await this.persistSnapshot();
    return { ok: true };
  }

  async release(runKey: string): Promise<void> {
    this.active.delete(runKey);
    await this.persistSnapshot();
  }

  async snapshot(): Promise<BackpressureSnapshot> {
    const stored = await this.store.loadBackpressureSnapshot();
    return stored ?? {
      updated_at: this.now().toISOString(),
      active: [],
      throttled: [],
    };
  }

  private async reject(
    lease: BackpressureLease,
    reason: string,
  ): Promise<{ ok: false; reason: string }> {
    this.throttled.push({
      providerId: lease.providerId,
      serviceKey: lease.serviceKey,
      reason,
      at: this.now().toISOString(),
    });
    if (this.throttled.length > 20) {
      this.throttled.splice(0, this.throttled.length - 20);
    }
    await this.persistSnapshot();
    return { ok: false, reason };
  }

  private async persistSnapshot(): Promise<void> {
    await this.store.saveBackpressureSnapshot({
      updated_at: this.now().toISOString(),
      active: [...this.active.values()].map((entry) => ({
        provider_id: entry.providerId,
        service_key: entry.serviceKey,
        run_key: entry.runKey,
        acquired_at: this.now().toISOString(),
      })),
      throttled: this.throttled.map((entry) => ({
        provider_id: entry.providerId,
        service_key: entry.serviceKey,
        reason: entry.reason,
        at: entry.at,
      })),
    });
  }
}
