import { z } from "zod";

// --- Trust Balance (per domain) ---

export const TrustBalanceSchema = z.object({
  domain: z.string(),
  balance: z.number().min(-100).max(100).default(0),
  success_delta: z.number().default(3),
  failure_delta: z.number().default(-10),
});
export type TrustBalance = z.infer<typeof TrustBalanceSchema>;

// --- Trust Store (all domains) ---

export const TrustStoreSchema = z.object({
  balances: z.record(z.string(), TrustBalanceSchema),
});
export type TrustStore = z.infer<typeof TrustStoreSchema>;

// --- Action Quadrant ---

export const ActionQuadrantEnum = z.enum([
  "autonomous",           // high trust + high confidence
  "execute_with_confirm", // high trust + low confidence OR low trust + high confidence
  "observe_and_propose",  // low trust + low confidence
]);
export type ActionQuadrant = z.infer<typeof ActionQuadrantEnum>;

/** High trust threshold: trust_balance >= 20 */
export const HIGH_TRUST_THRESHOLD = 20;

/** High confidence threshold: confidence >= 0.50 */
export const HIGH_CONFIDENCE_THRESHOLD = 0.50;

/** Trust change on success */
export const TRUST_SUCCESS_DELTA = 3;

/** Trust change on failure */
export const TRUST_FAILURE_DELTA = -10;
