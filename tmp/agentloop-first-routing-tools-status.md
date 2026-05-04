# AgentLoop-first routing/tools status

Started: 2026-05-05 JST

## Main sync

- Ran `git switch main && git pull --ff-only`.
- Updated `main` from `ed198d0b` to `f1830ea8` (`Fix RunSpec routing after configure misclassification (#1056)`).
- Remaining local untracked path: `.pulseed-sandbox/`.

## Issues

- #1057 AgentLoop-first chat ingress for non-exact freeform input: OPEN, next.
- #1058 Expose RunSpec and DurableLoop handoff as AgentLoop tools: OPEN, pending #1057.
- #1059 Move setup and runtime-control semantic decisions behind AgentLoop tools: OPEN, pending #1058.
- #1060 Remove freeform semantic shortcut rules from agent-facing paths: OPEN, pending #1059.

## #1057 plan

- Created `codex/issue-1057-agentloop-first-ingress`.
- Inspected production ingress in `ChatRunner`, `CrossPlatformChatSessionManager`, and route helpers.
- Demoted non-exact freeform semantic routing when a chat AgentLoop runner is available.
- Preserved pre-agent exact commands, approval/confirmation, explicit setup secret intake, precomputed typed RunSpec routes, and runtime guardrails.
- Added/updated production caller-path tests for Japanese DurableLoop/Kaggle text reaching AgentLoop, non-exact setup phrasing reaching AgentLoop, legacy no-AgentLoop RunSpec behavior, and denied runtime-control guardrails.
- Focused verification:
  - `npx vitest run src/interface/chat/__tests__/ingress-router.test.ts` passed.
  - `npx vitest run src/interface/chat/__tests__/cross-platform-session.test.ts` passed.
  - `npx vitest run src/interface/chat/__tests__/chat-runner.test.ts -t "routes to chatAgentLoopRunner|simple questions|Japanese DurableLoop|derives and persists a typed RunSpec"` passed.
- Review found a runtime-control explicit metadata miss could fall through to AgentLoop. Added `runtime_control_unclassified` blocked route for explicit disallowed runtime-control metadata when structured intent is unavailable.
- `npm run typecheck` passed.
- `npm run lint:boundaries` passed with existing warnings.
- `npm run test:changed` currently fails. Remaining failures are legacy tests expecting host-side configure/freeform/RunSpec/interrupt route classification before AgentLoop. These need test realignment and/or #1058/#1059 tool contracts before #1057 can be PR-ready.
- Request fresh review before PR.

## 2026-05-05 follow-up from parent session

- Fetched PR #1061 and reproduced CI build failure locally.
- CI failure root cause was a dead pre-agent RunSpec derivation branch:
  `freeformRouteIntent` was hard-coded to `null`, but the old `freeformRouteIntent.kind/confidence`
  checks remained, causing `tsconfig.build.json` to narrow the value to `never`.
- Removed that dead branch and unused `deriveRunSpecFromText` imports from
  `ChatRunner` and `CrossPlatformChatSessionManager`.
- `npm run build` passed after the fix.
- `npm run typecheck` passed.
- `npm run lint:boundaries` passed with existing warnings.
- `npm run test:changed` still fails with 29 tests. The remaining failures are not all
  mechanical test drift:
  - Some are expected old host-side freeform/configure/RunSpec route assertions that conflict
    with AgentLoop-first behavior.
  - Some expose that #1057 alone removes the old RunSpec/setup direct route before #1058/#1059
    provide equivalent model-visible tools. Merging #1057 alone would temporarily regress those
    user-facing flows unless the PR is narrowed or paired with the tool contracts.
- Recommendation: do not mark #1057 ready as a standalone behavior change yet. Either:
  1. narrow #1057 so existing RunSpec/setup behavior remains available until #1058/#1059 land, or
  2. combine the next implementation pass with #1058/#1059 tool contracts before trying to make
     the AgentLoop-first path PR-ready.
