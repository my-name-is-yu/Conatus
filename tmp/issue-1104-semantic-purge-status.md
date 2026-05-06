# Issue #1104/#1120 semantic purge implementation status

Created: 2026-05-07 JST
Repository: https://github.com/my-name-is-yu/PulSeed.git
Default branch: main

## #1163 typed evidence metadata

- Issue: #1163
- Risk lane: shared-api-schema + runtime-state
- Execution mode: independent PR
- Branch: yu/issue-1163-typed-evidence-metadata
- Base SHA: 4d75a5c730cfa6c26e7b9377d9571e276100d1cc
- Short plan:
  - Trace production agent-loop evidence promotion and command result handling.
  - Replace command-text evidence eligibility with typed verification plan or tool/result metadata.
  - Add focused tests plus production agent-loop caller-path coverage.
- Implementation notes:
  - Added a typed `verificationPlan` to agent-loop turns and command result evidence provenance.
  - Command evidence eligibility now comes from exact verification-plan commands or typed tool activity category metadata.
  - Removed the command regex/prefix/family classifier from agent-loop command evidence relevance.
  - Added production TaskAgentLoopRunner coverage for a keyword-looking stale command followed by a non-prefix declared verification command.
- Review:
  - Fresh independent review found one material stale-command issue in typed test-category relevance.
  - Fixed by requiring current verification-plan command matching whenever a declared plan is present.
- Validation:
  - `npx vitest run src/orchestrator/execution/agent-loop/__tests__/agent-loop-command-classifier.test.ts src/orchestrator/execution/agent-loop/__tests__/task-agent-loop-verification.test.ts src/orchestrator/execution/agent-loop/__tests__/agent-loop.test.ts src/orchestrator/execution/agent-loop/__tests__/agent-loop-dogfood-benchmark.test.ts` passed (46 tests).
  - `npm run typecheck` passed.
  - `npm run lint:boundaries` passed with existing warnings only.
  - `npm run test:changed` passed (41 files passed, 3 skipped; 658 tests passed, 3 skipped).
- Status: ready to commit
