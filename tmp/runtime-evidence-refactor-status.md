# Runtime Evidence Refactor Status

## Starting State

- `git switch main && git pull --ff-only`: main was already up to date.
- `gh issue list --state open --limit 100`: #1054, #1044, and #1050 are open.
- Scope remains fixed to #1054 -> #1044 -> #1050. New related open issues are noted only if they block, duplicate, or are prerequisites.

## #1054: CoreLoop Real-Store Evidence Contract

Status: in progress on `codex/issue-1054-coreloop-evidence-contract`.

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
