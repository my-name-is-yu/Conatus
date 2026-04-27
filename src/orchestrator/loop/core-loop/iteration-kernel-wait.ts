import type { CoreLoopDeps } from "./contracts.js";

export interface ActiveWaitObservationInput {
  goalTitle: string;
  waitStrategyId: string;
  waitReason: string;
  waitUntil: string;
  nextObserveAt?: string | null;
  conditions: string[];
  processRefs: string[];
  artifactRefs: string[];
  approvalPending: boolean;
}

export async function findActiveWaitObservationInput(
  deps: CoreLoopDeps,
  goalId: string,
  goalTitle: string
): Promise<ActiveWaitObservationInput | null> {
  if (typeof deps.strategyManager.getPortfolio !== "function") return null;
  const portfolio = await Promise.resolve(deps.strategyManager.getPortfolio(goalId)).catch(() => null);
  if (!portfolio || !deps.portfolioManager) return null;
  const strategy = portfolio.strategies.find((candidate) =>
    candidate.state === "active" && deps.portfolioManager?.isWaitStrategy(candidate)
  ) as { id: string; wait_reason?: string; wait_until?: string } | undefined;
  if (!strategy || typeof strategy.wait_until !== "string") return null;

  const metadataPath = `strategies/${goalId}/wait-meta/${strategy.id}.json`;
  const rawMetadata = await Promise.resolve(deps.stateManager.readRaw(metadataPath)).catch(() => null);
  const metadata = rawMetadata && typeof rawMetadata === "object" ? rawMetadata as Record<string, unknown> : {};
  const nextObserveAt = typeof metadata["next_observe_at"] === "string" ? metadata["next_observe_at"] : strategy.wait_until;
  const nextObserveAtMs = Date.parse(nextObserveAt);
  if (!Number.isFinite(nextObserveAtMs) || nextObserveAtMs > Date.now()) return null;
  const conditions = Array.isArray(metadata["conditions"]) ? metadata["conditions"] : [];
  const processRefs = Array.isArray(metadata["process_refs"]) ? metadata["process_refs"] : [];
  const artifactRefs = Array.isArray(metadata["artifact_refs"]) ? metadata["artifact_refs"] : [];
  const latestObservation = metadata["latest_observation"];
  const latest = latestObservation && typeof latestObservation === "object"
    ? latestObservation as Record<string, unknown>
    : {};
  const latestEvidence = latest["evidence"] && typeof latest["evidence"] === "object"
    ? latest["evidence"] as Record<string, unknown>
    : {};
  return {
    goalTitle,
    waitStrategyId: strategy.id,
    waitReason: typeof strategy.wait_reason === "string" ? strategy.wait_reason : "waiting",
    waitUntil: strategy.wait_until,
    nextObserveAt,
    conditions: conditions.map((condition) => JSON.stringify(condition)),
    processRefs: processRefs.map((ref) => JSON.stringify(ref)),
    artifactRefs: artifactRefs.map((ref) => JSON.stringify(ref)),
    approvalPending: Boolean(metadata["approval_pending"] ?? latestEvidence["approval_pending"]),
  };
}
