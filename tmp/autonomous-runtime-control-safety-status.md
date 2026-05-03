# Autonomous Runtime-Control Safety Status

Started: 2026-05-03

## Scope

- #996: merged via PR #1002. Goal was to preserve approval-denied/not-executed tool facts through chat agent-loop final output.
- #995: open, active. Goal is to route daemon lifecycle intent through typed runtime-control or fail closed.

## Working Notes

- Main was refreshed with `git switch main && git pull --ff-only`.
- Open issue list was checked with `gh issue list --state open --limit 100`.
- Existing unrelated worktree change observed: `tmp/autonomous-chat-setup-ux-status.md`. It will not be staged or included.

## #996 Plan

1. Done: added typed not-executed execution state to tool results/agent-loop outputs.
2. Done: approval-denied tool calls are marked `not_executed` at the executor/runtime boundary.
3. Done: command results carry execution state without relying on command-output text.
4. Done: added chat agent-loop contract tests for approval-denied not-executed results and genuine executed command failures.
5. Done: verification and fresh review.

## #996 Verification

- `npm test -- src/orchestrator/execution/agent-loop/__tests__/chat-agent-loop-contract.test.ts`: passed.
- `npm run typecheck`: passed.
- `npm run lint:boundaries`: passed with existing warnings, no errors.
- `npm run test:changed`: passed, 35 files passed and 3 skipped in related tests.
- `git diff --check`: passed.
- Fresh review agent: found two material issues.
  - Fixed P1: non-command approval-denied tools now flow through `AgentLoopResult.toolResults`, so final-output protection is not limited to command results.
  - Fixed P2: deterministic approval-denied output now also includes summaries from executed tool results in the same turn, instead of discarding all later successful/failed executed observations.
- Re-verification after review fixes:
  - `npm test -- src/orchestrator/execution/agent-loop/__tests__/chat-agent-loop-contract.test.ts`: passed, 16 tests.
  - `npm run typecheck`: passed.
  - `git diff --check`: passed.
  - `npm run lint:boundaries`: passed with existing warnings, no errors.
  - `npm run test:changed`: passed, 35 files passed and 3 skipped in related tests.
- Second fresh review after fixes: no findings.
- PR #1002 CI: `unit (22)` passed, `integration (24)` passed.
- PR #1002 merged with squash and branch deletion.

## #995 Plan

1. Done: inspected the current ingress/runtime-control route and production caller tests.
2. Done: identified fallback risk where runtime-control intent was only classified when service/policy allowed runtime-control route.
3. Done: added/adjusted production caller-path tests for runtime-control available and unavailable/not allowed.
4. Done: implemented `runtime_control_blocked` fail-closed routing without adding keyword/regex/includes freeform classifiers.
5. In progress: verification and fresh review.

## #995 Verification

- `npm test -- src/interface/chat/__tests__/ingress-router.test.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/runtime/control/__tests__/runtime-control-intent.test.ts`: passed.
- `npm run typecheck`: passed.
- `npm run lint:boundaries`: passed with existing warnings, no errors.
- `npm run test:changed`: passed, including related unit/integration and smoke lanes.
- `git diff --check`: passed.
- First fresh review agent: found one material issue.
  - Fixed P1: disallowed gateway messages no longer all pay runtime-control classification first. Gateway policies now emit typed `runtime_control_denied` metadata only when runtime-control allowlist is configured and the sender is not approved. Fail-closed classification uses that metadata or an explicit runtime-control request, while ordinary setup/chat routing is not preempted.
- Re-verification after review fix:
  - `npm test -- src/interface/chat/__tests__/chat-boundary-contract.test.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/ingress-router.test.ts src/runtime/gateway/__tests__/channel-policy.test.ts`: passed.
  - `npm run typecheck`: passed.
  - `npm run lint:boundaries`: passed with existing warnings, no errors.
  - `npm run test:changed`: passed, including related unit/integration and smoke lanes.
  - `git diff --check`: passed.
- Second fresh review agent: found two material issues.
  - Fixed P1: runtime-control classification no longer preempts all ordinary disallowed gateway messages just because the runtime-control service is wired.
  - Fixed P1: unavailable runtime-control fail-closed coverage now uses an explicit runtime-control contract instead of relying on broad CLI/TUI channel heuristics.
- Re-verification after second review fix:
  - `npm test -- src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/chat-boundary-contract.test.ts src/interface/chat/__tests__/ingress-router.test.ts`: passed, 35 tests.
  - `npm run test:changed`: passed, including related unit/integration and smoke lanes.
  - `npm run typecheck`: passed.
  - `npm run lint:boundaries`: passed with existing warnings, no errors.
  - `git diff --check`: passed.
- Final fresh review after second fix: found two material issues.
  - Fixed P1: post-setup refresh failure/unavailable responses no longer tell the operator to use `pulseed daemon restart/status` as shell lifecycle fallback.
  - Fixed P1: denied gateway metadata no longer blocks setup/configure routing before the runtime-control classifier; denied lifecycle messages still fail closed after setup/configure is ruled out.
- Re-verification after final review fixes:
  - `npm test -- src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/chat-runner.test.ts`: passed, 140 tests.
  - `npm run typecheck`: passed.
  - `npm run lint:boundaries`: passed with existing warnings, no errors.
  - `npm run test:changed`: passed, including related unit/integration and smoke lanes.
  - `git diff --check`: passed.
- Final re-review after fixes: no findings.
