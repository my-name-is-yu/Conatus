/**
 * Shared EthicsVerdict fixtures for test files.
 *
 * Two forms are provided:
 *   - JSON strings  (suffix _JSON)  — for createMockLLMClient() / LLM response mocks
 *   - Typed objects (no suffix)     — for direct mock injection (e.g. vi.fn().mockResolvedValue)
 */
import type { EthicsVerdict } from "../../src/base/types/ethics.js";
export declare const PASS_VERDICT: EthicsVerdict;
export declare const REJECT_VERDICT: EthicsVerdict;
export declare const FLAG_VERDICT: EthicsVerdict;
export declare const PASS_VERDICT_JSON: string;
export declare const REJECT_VERDICT_JSON: string;
export declare const FLAG_VERDICT_JSON: string;
/** Pass verdict JSON used by goal-negotiator and suggest tests (slightly different wording). */
export declare const PASS_VERDICT_SAFE_JSON: string;
/** Reject verdict JSON used by goal-negotiator and suggest tests. */
export declare const REJECT_VERDICT_ILLEGAL_JSON: string;
/** Flag verdict JSON used by goal-negotiator tests. */
export declare const FLAG_VERDICT_PRIVACY_JSON: string;
/** Simple pass verdict JSON used by goal-tree and negotiate-context tests. */
export declare const PASS_VERDICT_SIMPLE_JSON: string;
//# sourceMappingURL=ethics-fixtures.d.ts.map