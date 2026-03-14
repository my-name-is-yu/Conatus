# Production Bug Investigation

Investigated 2026-03-14 based on test quality audit findings.

---

## Bug 1: TrustManager mock名不一致

- **Status**: NO BUG
- **Evidence**:
  - `src/trust-manager.ts:234` — the actual public method is `hasPermanentGate(domain, category): boolean`
  - `src/tui/use-loop.ts` — `LoopController` only calls `trustManager.getBalance(goalId)` (line 183). It does NOT call `isPermanentlyGated` or `hasPermanentGate` at all.
  - The mock name mismatch flagged in the test audit exists in the test file, not in production code. The production call site uses `getBalance`, which is the correct method name.
- **Fix needed**: None in production code. Test mock may use wrong method name (`isPermanentlyGated` vs `hasPermanentGate`), but that is a test-only issue.

---

## Bug 2: ReportType不一致

- **Status**: NO BUG
- **Evidence**:
  - `src/tui/actions.ts:149` — `ActionHandler.handleReport()` calls `this.deps.reportingEngine.generateDailySummary(id)` directly. It does NOT construct a report object with a `report_type` string field.
  - `src/types/core.ts:212-222` — `ReportTypeEnum` valid values are: `"daily_summary"`, `"weekly_report"`, `"urgent_alert"`, `"approval_request"`, `"stall_escalation"`, `"goal_completion"`, `"strategy_change"`, `"capability_escalation"`, `"execution_summary"`. There is no `"daily"` value.
  - `generateDailySummary` in `reporting-engine.ts` internally sets `report_type: "daily_summary"` (confirmed via the method name and schema). The `actions.ts` code never passes a raw string for `report_type`.
  - The string `"daily"` or `"daily_summary"` does not appear in `actions.ts` at all.
- **Fix needed**: None. The concern was a false alarm — `actions.ts` delegates to a typed method rather than constructing a raw report type string.

---

## Bug 3: TaskLifecycle L2 retry logging

- **Status**: BUG CONFIRMED (minor)
- **Evidence**:
  - `src/task-lifecycle.ts:362-374` — when L1 passes and L2 fails, a retry is triggered: `const l2Retry = await this.runLLMReview(task, executionResult)` (line 364). The retry result (`l2Retry`) determines the final `verdict` and `confidence`.
  - `src/task-lifecycle.ts:403-424` — the `evidence` array is constructed using `l2Result.description` and `l2Result.confidence` (the original failed L2 result), not `l2Retry.description`. The retry's outcome is never recorded in evidence.
  - Consequence: when the retry changes the verdict (e.g., from fail to pass), the `evidence` array still records the initial-fail L2 description, making the audit trail misleading. The final verdict says "pass" but evidence reads "fail."
- **Fix needed**: After the retry path completes, replace or supplement the L2 evidence entry with `l2Retry.description` and `l2Retry.confidence`. Simplest fix: capture the effective L2 result in a variable (`effectiveL2`) and use it when building evidence.

---

## Bug 4: intent-recognizer parseJSON

- **Status**: NO BUG
- **Evidence**:
  - `src/tui/intent-recognizer.ts:126` — `llmFallback` calls `this.llmClient!.parseJSON(llmResponse.content, LLMIntentSchema)`, using the injected `ILLMClient.parseJSON` method with a Zod schema for type-safe parsing.
  - There is no raw `JSON.parse` call anywhere in `intent-recognizer.ts`.
  - The `parseJSON` method on `ILLMClient` (implemented by both `LLMClient` and `MockLLMClient`) handles JSON extraction and Zod validation. Using it is the correct pattern.
- **Fix needed**: None.

---

## Summary

| Bug | Status | Needs Fix? |
|-----|--------|------------|
| Bug 1: TrustManager mock名不一致 | NO BUG | No — production code uses `getBalance`, not the flagged methods |
| Bug 2: ReportType不一致 | NO BUG | No — `actions.ts` delegates to a typed method, never uses raw string |
| Bug 3: TaskLifecycle L2 retry logging | BUG CONFIRMED (minor) | Yes — retry result should be used in evidence array, not original L2 result |
| Bug 4: intent-recognizer parseJSON | NO BUG | No — correctly uses `llmClient.parseJSON` with Zod schema |

**One fix required**: `src/task-lifecycle.ts` around lines 362-424 — capture `l2Retry` as the effective L2 result and use its `description`/`confidence` when building the `evidence` array.
