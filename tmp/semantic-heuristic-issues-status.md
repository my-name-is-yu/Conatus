# Semantic heuristic issue status

## Startup
- 2026-05-04: Ran `git switch main && git pull --ff-only`; main was already up to date.
- 2026-05-04: Ran `gh issue list --state open --limit 100`; target issues #1029, #1030, #1031, #1032, #1033, #1034, and #1035 are open. Other open issues are not blockers/prerequisites for this batch.

## #1029
- Status: implementation verified locally; preparing PR.
- Plan: add a typed `StrategyLineageAssessment` contract in divergent recovery, prefer existing exploration metadata plus evidence-ledger failed lineage fingerprints and metric trend/smoke evidence, demote text overlap to diagnostic fallback, and pass failed lineage context through the production durable stall path.
- Review: fresh review agent found lexical diagnostics still affected ranking and predicted recovery lacked failed-lineage plumbing/test coverage; fixed both before PR.
- Verification: `npm run typecheck`; `npx vitest run src/orchestrator/strategy/__tests__/strategy-manager-stall.test.ts src/orchestrator/loop/__tests__/core-loop-stall-refine.test.ts`; `npm run test:changed`; `npm run lint:boundaries` (warnings only, pre-existing).
