# Natural-language Longrun Handoff Status

## 2026-05-03

- Start state: `/Users/yuyoshimuta/Documents/dev/SeedPulse` did not exist in this environment, so work continues in `/Users/yuyoshimuta/PulSeed`.
- Ran `git switch main && git pull --ff-only`: main was current.
- Ran `gh issue list --state open --limit 100`: #997, #998, #999, #1000, #1001, and parent #986 are open.
- Scope guard: not touching resident channel readiness issues #984/#985/#987/#994.

## #997

- Branch: `codex/issue-997-runspec-draft-route`.
- Plan: reuse existing structured `runtime/run-spec` LLM derivation, extend RunSpec origin metadata, add a typed `run_spec_draft` chat route, and persist/display the draft without starting daemon work.
- Current status: implemented locally.
- Verification:
  - `npm run typecheck`: pass.
  - `npm run test:unit -- src/interface/chat/__tests__/chat-runner.test.ts -t "natural-language RunSpec draft routing"`: pass.
  - `npm run test:unit -- src/interface/chat/__tests__/cross-platform-session.test.ts -t "RunSpec draft"`: pass.
  - `npm run test:unit -- src/interface/chat/__tests__/ingress-router.test.ts src/runtime/run-spec/__tests__/run-spec.test.ts`: pass.
  - `npm run lint:boundaries`: pass with existing warnings only.
  - `git diff --check`: pass.
  - `npm run test:unit -- src/interface/chat/__tests__/chat-runner.test.ts`: 119 pass, 2 local Telegram setup expectation failures observed; failures assert unconfigured setup guidance while the local status provider reports configured Telegram config/home chat.
  - `npm run test:changed`: failed only on 4 Telegram setup guidance expectations (`chat-runner.test.ts` x2, `cross-platform-session.test.ts` x2) for the same local configured-Telegram status reason; related non-setup tests passed.
- Review: first review found CrossPlatformChatSessionManager bypassed the new draft route because it preselected routes before ChatRunner. Fixed by deriving/passing `runSpecDraft` in the cross-platform route selection path and adding a gateway production-path test.

## #998

- Branch: `codex/issue-998-runspec-confirmation`.
- Plan: persist pending RunSpec confirmation in chat session state, route next-turn input through the existing typed RunSpec confirmation state machine, and keep daemon start out of scope.
- Current status: implemented locally.
- Verification:
  - `npm run typecheck`: pass.
  - `npm run test:unit -- src/interface/chat/__tests__/chat-runner.test.ts -t "natural-language RunSpec draft routing"`: pass.
  - `npm run test:unit -- src/interface/chat/__tests__/cross-platform-session.test.ts -t "RunSpec draft"`: pass.
  - `npm run test:unit -- src/interface/chat/__tests__/chat-session-store.test.ts src/interface/chat/__tests__/chat-history.test.ts`: pass.
  - `git diff --check`: pass.
- Review: first review found `runSpecConfirmation` was persisted in raw chat history but dropped through `LoadedChatSession`/resume conversion. Fixed by threading the field through session load/save conversion and adding a reload-before-approval test. Re-review: no material findings.

## #999

- Branch: `codex/issue-999-start-confirmed-runs`.
- Plan: after typed approval, derive/save a CoreLoop goal from the confirmed RunSpec, create a durable `run:coreloop:*` background run record, then call `DaemonClient.startGoal` with the background-run metadata.
- Current status: implemented locally.
- Verification:
  - `npm run typecheck`: pass.
  - `npm run test:unit -- src/interface/chat/__tests__/chat-runner.test.ts -t "natural-language RunSpec draft routing"`: pass.
  - `npm run test:unit -- src/interface/chat/__tests__/cross-platform-session.test.ts -t "RunSpec draft"`: pass.
  - `npm run test:integration -- src/runtime/session-registry/__tests__/runtime-session-registry.test.ts`: pass.
  - `npm run lint:boundaries`: pass with existing warnings.
  - `git diff --check`: pass.
  - `npm run test:unit -- src/runtime/session-registry/__tests__/runtime-session-registry.test.ts -t "background"`: not applicable in unit config because runtime tests are excluded.
  - `npm run test:integration -- src/runtime/session-registry/__tests__/runtime-session-registry.test.ts -t "background"`: suite was skipped by filter/config.
- Review: first review found configured daemon runtime ledger records could be invisible or stale in `/sessions`. Fixed by mirroring initial records and updating RuntimeSessionRegistry to read/merge both state-base and configured daemon runtime ledgers. Re-review: no material findings.

## #1000

- Branch: `codex/issue-1000-runspec-safety`.
- Plan: add a typed pre-start safety validation for confirmed RunSpecs so unresolved required fields, missing/ambiguous workspace, and disallowed external/secret/irreversible policies fail before daemon start or background-run creation.
- Current status: implemented locally; review pending.
- Verification:
  - `npm run test:unit -- src/interface/chat/__tests__/chat-runner.test.ts -t "natural-language RunSpec draft routing"`: pass after review fixes (12 pass, 118 skipped).
  - `npm run test:unit -- src/interface/chat/__tests__/chat-runner.test.ts -t "blocks approved RunSpecs"`: pass.
  - `npm run typecheck`: pass.
  - `npm run lint:boundaries`: pass with existing warnings only.
  - `git diff --check`: pass.
- Review: fresh review found no material issues; new tests exercise real ChatRunner/CrossPlatform flows with appropriate mocked LLM/daemon boundaries and no brittle semantic decision logic.
- Review: first review found safety-blocked approvals were persisted as confirmed and low-confidence workspaces were not treated as ambiguous. Fixed by keeping safety-blocked specs pending/draft and blocking low-confidence workspaces before daemon start.

## #1001

- Branch: `codex/issue-1001-production-path-tests`.
- Plan: strengthen production caller-path tests for natural-language RunSpec handoff by asserting ChatRunner routes natural language through draft -> confirmation -> approved daemon start, CrossPlatform/gateway reply target metadata survives into the background run after approval, stale approvals do not reuse cancelled specs, and non-run questions stay on ordinary chat.
- Current status: implemented locally; review pending.
- Verification:
  - `npm run test:unit -- src/interface/chat/__tests__/chat-runner.test.ts -t "natural-language RunSpec draft routing"`: pass (13 pass, 118 skipped).
  - `npm run test:unit -- src/interface/chat/__tests__/cross-platform-session.test.ts -t "RunSpec"`: pass (2 pass, 22 skipped).
  - `npm run typecheck`: pass.
  - `npm run lint:boundaries`: pass with existing warnings only.
  - `git diff --check`: pass.
