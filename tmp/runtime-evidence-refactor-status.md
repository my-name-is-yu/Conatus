# Runtime Evidence Refactor Status

## Starting State

- `git switch main && git pull --ff-only`: main was already up to date.
- `gh issue list --state open --limit 100`: #1054, #1044, and #1050 are open.
- Scope remains fixed to #1054 -> #1044 -> #1050. New related open issues are noted only if they block, duplicate, or are prerequisites.

## #1054: CoreLoop Real-Store Evidence Contract

Status: merged via PR #1069.

Plan:
- Keep existing mock-heavy integration tests intact.
- Add a real-store contract section in `src/orchestrator/loop/__tests__/core-loop-integrations.test.ts`.
- Use real `StateManager`, real `RuntimeEvidenceLedger`, and real `ApprovalStore` in the loop dependency graph.
- Exercise `CoreLoop.run(...)` / `runOneIteration(...)` production paths, not low-level ledger helpers directly.
- Verify both successful evidence write scope (`goal_id`, `run_id`, `loop_index`) and the current failure contract (`logger.warn` without aborting the iteration).

Notes:
- Current implementation catches runtime evidence append failures inside `CoreIterationKernel` and logs `CoreLoop: failed to append runtime evidence ledger entry`; the test should lock that observable contract rather than expecting a thrown error.

Verification:
- `npm run typecheck`: pass.
- `npx vitest run src/orchestrator/loop/__tests__/core-loop-integrations.test.ts --config vitest.integration.config.ts`: pass, 46 tests, after adding this contract file to the integration include patterns.
- `npx vitest run src/runtime/__tests__/runtime-evidence-ledger.test.ts --config vitest.integration.config.ts`: pass, 41 tests.

Review:
- Fresh review found that the initial contract tests were excluded from the requested integration lane, had an unwired ApprovalStore assertion, and did not pin the failed append kinds tightly enough.
- Fixed by including the test in the integration lane, routing a wait approval through a real `ApprovalBroker` backed by real `ApprovalStore`, and asserting failed `task_generation` and `verification` append warnings.

## #1044: Runtime Evidence Schema/Type Split

Status: merged via PR #1070.

Plan:
- Extract runtime evidence schemas and entry/read types from `src/runtime/store/evidence-ledger.ts` to `src/runtime/store/evidence-types.ts`.
- Keep public re-exports from `evidence-ledger.ts` stable for existing imports.
- Move store helper modules that only need entry/schema contracts to import `evidence-types.ts`.
- Avoid candidate ranking, append/read/index, or summary behavior changes.

Implementation notes:
- Added `evidence-types.ts` for evidence schemas/types and moved `RuntimeArtifactRetentionClassSchema` there so artifact refs do not depend on the artifact-retention summarizer.
- Updated helper imports in `metric-history.ts`, `artifact-retention.ts`, `evaluator-results.ts`, `research-evidence.ts`, `dream-checkpoints.ts`, `experiment-queue-store.ts`, `postmortem-report.ts`, and `reproducibility-manifest.ts` where they only need lower-level contracts.
- Replaced type-only reproducibility manifest imports in ledger/artifact retention with local minimal manifest shapes to remove store-helper cycles without changing runtime parsing behavior.
- `src/runtime/store/evidence-ledger.ts` shrank from 2682 lines to 2253 lines; `evidence-types.ts` is 549 lines.

Verification:
- `npm run typecheck`: pass.
- `npx vitest run src/runtime/__tests__/runtime-evidence-ledger.test.ts --config vitest.integration.config.ts`: pass, 41 tests.
- `npx madge --circular --extensions ts,tsx --ts-config tsconfig.json src/runtime/store`: pass, no circular dependency found.

Review:
- Fresh review found two public export regressions: missing `RuntimeEvidenceMemoryUsageStats*` re-exports from `evidence-ledger.ts` and missing retention-class exports from the `runtime/store` barrel.
- Restored those re-exports while keeping helper imports pointed at lower-level contracts.

CI:
- Initial integration CI hit an unrelated `src/runtime/__tests__/loop-supervisor.test.ts` timeout after the runtime evidence ledger lane passed locally and in CI context.
- Local focused rerun of `loop-supervisor.test.ts` passed; reran the failed CI job, which passed before merge.

## #1050: Structured Candidate Ranking Fields

Status: merged via PR #1071.

Plan:
- Keep the candidate summary shape stable.
- Replace lineage/label-derived ranking penalties with explicit structured candidate fields.
- Make explicit `near_miss.reason_to_keep` authoritative when present instead of expanding it from label/lineage text.
- Remove primary metric selection preference based on metric label text and cover metric source labels with summary-level tests.
- Avoid schema migration beyond existing structured fields.

Implementation notes:
- Candidate risk now uses `candidate.robustness.risk_penalty` when provided, otherwise no inferred text penalty.
- Near-miss reasons preserve explicit `near_miss.reason_to_keep` exactly; inferred reasons remain only for textless structured status/similarity/score/family evidence.
- Candidate primary metric selection now breaks ties structurally by coverage, metric position, then recency, without local/public/leaderboard label heuristics.
- Added runtime evidence summary tests covering harmless manual/threshold/postprocess/stack/ensemble/blend/public/leaderboard/external labels, explicit near-miss reasons, and public/external metric source text.

Verification:
- `npm run typecheck`: pass.
- `npx vitest run src/runtime/__tests__/runtime-evidence-ledger.test.ts --config vitest.integration.config.ts`: pass, 43 tests.
- `npm run lint:boundaries`: pass with existing warnings.
- `npm run test:changed`: pass, 57 related test files and 8 smoke test files.

Review:
- Fresh review found no material issues.

CI:
- PR #1071 CI passed: `unit (22)` and `integration (24)`.
