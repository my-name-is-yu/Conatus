# Autonomous Runtime-Control Safety Status

Started: 2026-05-03

## Scope

- #996: open, active first. Goal is to preserve approval-denied/not-executed tool facts through chat agent-loop final output.
- #995: open, queued after #996. Goal is to route daemon lifecycle intent through typed runtime-control or fail closed.

## Working Notes

- Main was refreshed with `git switch main && git pull --ff-only`.
- Open issue list was checked with `gh issue list --state open --limit 100`.
- Existing unrelated worktree change observed: `tmp/autonomous-chat-setup-ux-status.md`. It will not be touched.

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
