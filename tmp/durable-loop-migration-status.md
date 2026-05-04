# DurableLoop Migration Status

## Initial state

- 2026-05-04: Ran `git switch main && git pull --ff-only`.
- 2026-05-04: Ran `gh issue list --state open --limit 100`.
- Target issues #1015, #1016, #1017, #1018, and #1019 are open.
- Related open issues exist, including #502, but the #1015-#1019 sequence remains the priority. No blocker, duplicate, or prerequisite has been identified yet.
- Untracked `.pulseed-sandbox/` existed before these edits and is left untouched.

## #1015 Define the DurableLoop naming contract and compatibility policy

- Status: in progress.
- Branch: `codex/issue-1015-durable-loop-contract`.
- Issue body reviewed with `gh issue view 1015`.
- Current `CoreLoop|core-loop|coreloop` usage was inventoried with `rg` across docs, source, and tests.
- Plan: add a short naming contract note only. Do not perform implementation renames in this issue.
- Review: separate review agent found one material issue: `tmp/` is gitignored, so the files must be committed with `git add -f`. The note content otherwise satisfies the acceptance criteria.
- Verification: `npm run typecheck` passed. `npm run lint:boundaries` passed with existing warnings and no errors.

## #1016 Introduce DurableLoop aliases while preserving CoreLoop callers

- Status: in progress.
- Branch: `codex/issue-1016-durable-loop-aliases`.
- Issue body reviewed with `gh issue view 1016`.
- Plan: add `DurableLoop` class/type aliases at the existing `core-loop` module, add DurableLoop-named agent-loop control tool factories, keep legacy `CoreLoop` names as deprecated compatibility exports, and add focused alias tests. No file moves or persisted ID changes in this issue.
- Verification: `npm run typecheck` passed. `npx vitest run src/orchestrator/loop/__tests__/durable-loop-aliases.test.ts` passed. `npx vitest run src/orchestrator/execution/agent-loop/__tests__/agent-loop-phases-3-7.test.ts` passed. `npm run lint:boundaries` passed with existing warnings and no errors. `rg -n "DurableLoop" src/orchestrator/loop src/orchestrator/execution/agent-loop/core-loop-control-tools.ts` confirmed new names.
- `npm run test:changed` failed because existing untracked `.pulseed-sandbox` local state was included and changed Telegram setup expectations in unrelated chat tests; focused tests for changed code passed.
- Review: separate review agent found no material issues.
