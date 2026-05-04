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

## #1017 Rename internal core-loop modules to durable-loop with compatibility shims

- Status: in progress.
- Branch: `codex/issue-1017-durable-loop-module-move`.
- Issue body reviewed with `gh issue view 1017`.
- Plan: move the primary implementation directory to `src/orchestrator/loop/durable-loop/`, move the top-level implementation to `src/orchestrator/loop/durable-loop.ts`, move agent-loop control tools to `durable-loop-control-tools.ts`, update production imports to durable paths, and leave old `core-loop` paths as re-export compatibility shims.
- Persisted run IDs, event kinds, session kinds, and user-facing CLI/chat wording are not being changed in this issue.
- Verification: `npm run typecheck` passed. Focused tests passed: `npx vitest run src/orchestrator/loop/__tests__/durable-loop-aliases.test.ts src/orchestrator/loop/__tests__/core-loop-run-policy.test.ts src/orchestrator/loop/__tests__/core-loop-decision-engine.test.ts src/orchestrator/execution/agent-loop/__tests__/agent-loop-phases-3-7.test.ts`. `npm run lint:boundaries` passed with existing warnings and no errors.
- `rg -n "from .*core-loop|import\\(.*core-loop|\\.\\/core-loop|\\.\\.\\/core-loop" src -g '*.ts'` returned no remaining source imports after migration.
- Intentional leftovers from `rg -n "CoreLoop|core-loop|coreloop" src/orchestrator/loop src/orchestrator/execution/agent-loop -g '*.ts'`: legacy compatibility shims, deprecated compatibility export names, compatibility alias tests, unchanged persisted/wire names such as `core_*` tool names and `run:coreloop:*`, and log/message text deferred to #1018.
- Review: separate review agent found no material issues and confirmed old/new compiled ESM import paths still resolve.

## #1018 Rename runtime, session, and user-facing CoreLoop labels to DurableLoop with legacy compatibility

- Status: in progress.
- Branch: `codex/issue-1018-durable-loop-user-labels`.
- Issue body reviewed with `gh issue view 1018`.
- Plan: update user-facing labels in chat/CLI/tool descriptions/runtime session titles/background run summaries to `DurableLoop`; keep legacy persisted IDs and kinds (`run:coreloop:*`, `session:coreloop:*`, `coreloop_run`, `coreloop`) unchanged and readable.
- Compatibility note: runtime-control goal ID fallback now accepts both `DurableLoop goal <id>` and legacy `CoreLoop goal <id>` titles. This is deterministic parsing of an internal title compatibility surface, not freeform semantic routing.
- Verification: `npm run typecheck` passed. `npm run lint:boundaries` passed with existing warnings and no errors. Runtime/session/control focused tests in the bundle passed. Chat caller-path DurableLoop label tests passed with targeted `-t` runs for `starts a confirmed RunSpec only after next-turn approval` and `starts a gateway natural-language RunSpec after approval and retains reply target metadata`.
- Full chat focused bundle also ran but failed in unrelated Telegram setup tests because existing untracked `.pulseed-sandbox` local state reports Telegram/Home chat configured; this is the same local-state issue seen in #1016 and not caused by DurableLoop label changes.
- Review: separate review agent found one missed user-facing chat safety response label. Fixed `background CoreLoop work` to `background DurableLoop work`.
- Re-verification after review fix: `npm run typecheck`, `npm run lint:boundaries`, runtime/session/control/agent-loop focused tests, and targeted chat/cross-platform DurableLoop caller-path tests passed.

## #1019 Clean up DurableLoop documentation and retire obsolete CoreLoop aliases

- Status: in progress.
- Branch: `codex/issue-1019-durable-loop-doc-cleanup`.
- Issue body reviewed with `gh issue view 1019`.
- Plan: update current-facing README/docs/architecture text and ArchitectureTool labels to DurableLoop. Keep compatibility shims, public deprecated API names, legacy persisted identifiers (`run:coreloop:*`, `session:coreloop:*`, `coreloop_run`, `coreloop`), and tests that document compatibility.
- Alias decision: keep deprecated TypeScript aliases and shims for this migration because downstream callers and legacy import paths still need compatibility after #1017/#1018. Do not remove persisted/wire compatibility surfaces.
- Review: separate review agent found one stale `core_concept.core_loop` ArchitectureTool output key. Fixed to `core_concept.durable_loop` and added a regression assertion.
- Verification after review fix: `npm run check:docs`, `npx vitest run src/tools/query/ArchitectureTool/__tests__/ArchitectureTool.test.ts`, `npm run typecheck`, and `npm run lint:boundaries` passed. `lint:boundaries` reports existing warnings only.
- `npm run test:changed` ran and passed docs/ArchitectureTool related checks, then failed in unrelated Telegram chat setup expectations because untracked `.pulseed-sandbox` runtime/config state reports Telegram/Home chat configured. This is the same local-state issue recorded in earlier migration PRs and is not caused by #1019 docs/tool label changes.
