/**
 * Shared EthicsVerdict fixtures for test files.
 *
 * Two forms are provided:
 *   - JSON strings  (suffix _JSON)  — for createMockLLMClient() / LLM response mocks
 *   - Typed objects (no suffix)     — for direct mock injection (e.g. vi.fn().mockResolvedValue)
 */
// ─── Typed object fixtures ────────────────────────────────────────────────────
export const PASS_VERDICT = {
    verdict: "pass",
    category: "safe",
    reasoning: "Task approach is safe",
    risks: [],
    confidence: 0.9,
};
export const REJECT_VERDICT = {
    verdict: "reject",
    category: "harmful",
    reasoning: "Task involves harmful actions",
    risks: ["potential harm to users"],
    confidence: 0.95,
};
export const FLAG_VERDICT = {
    verdict: "flag",
    category: "privacy_concern",
    reasoning: "Task may expose user data",
    risks: ["privacy risk"],
    confidence: 0.7,
};
// ─── JSON string fixtures (for LLM mock responses) ───────────────────────────
export const PASS_VERDICT_JSON = JSON.stringify({
    verdict: "pass",
    category: "safe",
    reasoning: "This goal is clearly safe and ethical.",
    risks: [],
    confidence: 0.95,
});
export const REJECT_VERDICT_JSON = JSON.stringify({
    verdict: "reject",
    category: "illegal",
    reasoning: "This goal involves clearly illegal activities.",
    risks: ["illegal activity", "potential harm to others"],
    confidence: 0.99,
});
export const FLAG_VERDICT_JSON = JSON.stringify({
    verdict: "flag",
    category: "privacy_concern",
    reasoning: "This goal involves collecting user data, which may raise privacy concerns.",
    risks: ["potential privacy violation", "data misuse"],
    confidence: 0.70,
});
/** Pass verdict JSON used by goal-negotiator and suggest tests (slightly different wording). */
export const PASS_VERDICT_SAFE_JSON = JSON.stringify({
    verdict: "pass",
    category: "safe",
    reasoning: "This goal is clearly safe.",
    risks: [],
    confidence: 0.95,
});
/** Reject verdict JSON used by goal-negotiator and suggest tests. */
export const REJECT_VERDICT_ILLEGAL_JSON = JSON.stringify({
    verdict: "reject",
    category: "illegal",
    reasoning: "This goal involves illegal activities.",
    risks: ["illegal activity"],
    confidence: 0.99,
});
/** Flag verdict JSON used by goal-negotiator tests. */
export const FLAG_VERDICT_PRIVACY_JSON = JSON.stringify({
    verdict: "flag",
    category: "privacy_concern",
    reasoning: "Privacy risks identified.",
    risks: ["data collection concern", "potential misuse"],
    confidence: 0.70,
});
/** Simple pass verdict JSON used by goal-tree and negotiate-context tests. */
export const PASS_VERDICT_SIMPLE_JSON = JSON.stringify({
    verdict: "pass",
    category: "safe",
    reasoning: "Safe goal.",
    risks: [],
    confidence: 0.95,
});
//# sourceMappingURL=ethics-fixtures.js.map