# Semantic heuristic issue status

## Startup
- 2026-05-04: Ran `git switch main && git pull --ff-only`; main was already up to date.
- 2026-05-04: Ran `gh issue list --state open --limit 100`; target issues #1029, #1030, #1031, #1032, #1033, #1034, and #1035 are open. Other open issues are not blockers/prerequisites for this batch.

## #1029
- Status: implementation verified locally; preparing PR.
- Plan: add a typed `StrategyLineageAssessment` contract in divergent recovery, prefer existing exploration metadata plus evidence-ledger failed lineage fingerprints and metric trend/smoke evidence, demote text overlap to diagnostic fallback, and pass failed lineage context through the production durable stall path.
- Review: fresh review agent found lexical diagnostics still affected ranking and predicted recovery lacked failed-lineage plumbing/test coverage; fixed both before PR.
- Verification: `npm run typecheck`; `npx vitest run src/orchestrator/strategy/__tests__/strategy-manager-stall.test.ts src/orchestrator/loop/__tests__/core-loop-stall-refine.test.ts`; `npm run test:changed`; `npm run lint:boundaries` (warnings only, pre-existing).
- Result: PR #1036 merged; CI unit (22) and integration (24) passed.

## #1034
- Status: implementation verified locally; preparing PR.
- Plan: extend `DecisionRecord` with typed lineage metadata, record lineage metadata from active strategies in the durable stall path, and replace exact-hypothesis ranking in `StrategyManagerBase` with typed lineage-key scoring. Exact hypothesis remains diagnostic-only.
- Review: fresh review agent reported no material findings.
- Verification: `npm run typecheck`; `npx vitest run src/orchestrator/strategy/__tests__/strategy-manager-core.test.ts src/orchestrator/loop/__tests__/core-loop-stall-refine.test.ts src/platform/knowledge/__tests__/decision-record.test.ts`; `npm run test:changed`; `npm run lint:boundaries` (warnings only, pre-existing).
- Result: PR #1037 merged; CI unit (22) and integration (24) passed.

## #1030
- Status: implementation verified locally; preparing PR.
- Plan: deprecate `*_hypothesis_includes` as production selectors, add typed Dream decision heuristic selectors, keep `verifiedPlannerHintsOnly` as the caller-path gate, and cover direct heuristic behavior plus `StrategyManagerBase.generateCandidates()`.
- Review: fresh review agent reported no material findings.
- Verification: `npm run typecheck`; `npx vitest run src/orchestrator/strategy/__tests__/strategy-manager-core.test.ts`; `npm run test:changed`; `npm run lint:boundaries` (warnings only, pre-existing).
- Result: PR #1038 merged; CI unit (22) and integration (24) passed.

## #1031
- Status: implementation verified locally after review fix.
- Plan: keep learned pattern/workflow retrieval advisory-only, require typed template applicability for strategy-materializing candidates, and attach template ranking trace provenance showing source/confidence/lexical-overlap usage.
- Review: fresh review agent found stored `embedding_id` was incorrectly treated as embedding-backed retrieval; fixed selector to require typed applicability in the current production path and added coverage with a non-null stored embedding id.
- Verification: `npm run typecheck`; `npx vitest run src/orchestrator/strategy/__tests__/strategy-manager-core.test.ts`; `npm run test:changed`; `npm run lint:boundaries` (warnings only, pre-existing).

## #1033
- Status: implementation verified locally after review fixes; preparing PR.
- Plan: extend `StallTaskHistoryEntry` with optional typed task-result evidence, prefer typed no-op/material-change signals in `detectRepetitivePatterns()`, mark phrase/bigram text matching as low-confidence fallback with source, and cover the `StallDetector.detectRepetitivePatterns()` caller path.
- Review: fresh review agent found mixed typed/untyped windows could still fall through to text fallback after one material change, and tool-call-only/not-run evidence was too weak for typed no-op; fixed both and added regression coverage.
- Verification: `npm run typecheck`; `npx vitest run src/platform/drive/__tests__/stall-detector-repetitive.test.ts`; `npm run lint:boundaries` (warnings only, pre-existing); `npm run test:changed`.

## #1032
- Status: implementation verified locally after review fixes; preparing PR.
- Plan: route `generateProposals()` through concrete semantic-transfer search evidence, add typed proposal transfer evidence with source goal/dimension/similarity/evidence refs, include that evidence in proposal prompts, and only assign `embedding_similarity` when admitted vector results exist.
- Review: fresh review agent found model-provided `embedding_similarity` could be accepted without vector evidence and gateway prompt assembly could drop transfer evidence; fixed by sanitizing detection methods without evidence and using the concrete proposal prompt path.
- Verification: `npm run typecheck`; `npx vitest run src/platform/traits/__tests__/curiosity-engine-budget.test.ts src/platform/traits/__tests__/curiosity-engine-proposals.test.ts`; `npm run lint:boundaries` (warnings only, pre-existing); `npm run test:changed`.

## #1035
- Status: implementation verified locally; preparing PR.
- Plan: make semantic retrieval capability explicit in `CodeSearchIndexes`, default it to disabled, exclude the semantic retriever from the orchestrator unless capability is enabled, and make reranking ignore semantic similarity when disabled so ranking/reasons are unaffected.
- Review: fresh review agent reported no material findings.
- Verification: `npm run typecheck`; `npx vitest run src/platform/code-search/__tests__/code-search.test.ts`; `npm run lint:boundaries` (warnings only, pre-existing); `npm run test:changed` (exit 0; included pre-existing `ps: process id too large: 999999999` output).
