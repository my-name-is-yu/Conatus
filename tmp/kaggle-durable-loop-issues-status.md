# Kaggle Durable Loop Issues Status

Updated: 2026-05-06 Asia/Tokyo

## Startup

- Ran `git switch main && git pull --ff-only`: already on up-to-date `main`.
- Ran `gh issue list --state open --limit 100`: target issues #1089, #1090, #1091, and #1093 are open.
- New adjacent open issues #1094 and #1095 exist, but current work remains focused on #1089/#1090/#1091/#1093 unless they become blockers.

## #1089

Status: implementation verified locally; preparing PR.

Plan:
- Resolve effective task workspace from task `workspace_path` constraint, then goal `workspace_path` constraint, then existing lifecycle default.
- Pass that cwd into `TaskAgentLoopRunner.runTask()` for native task execution.
- Keep diff capture on the runner-reported execution cwd, which should now be the goal workspace.
- Preserve revert safety by passing the same effective workspace into verifier deps.
- Add a production caller-path test with daemon tmp cwd different from goal workspace.

Implemented:
- Added shared `resolveTaskWorkspacePath()` helper.
- Native task lifecycle now passes the effective task/goal workspace cwd into `TaskAgentLoopRunner.runTask()`.
- Verification diff fallback and revert cwd resolution now prefer task/goal `workspace_path` over stale daemon defaults.
- Added production-path native agent-loop test for daemon cwd != goal workspace.
- Added revert regression test for goal workspace overriding stale daemon `revertCwd`.

Verification:
- `npm test -- --run src/orchestrator/execution/agent-loop/__tests__/agent-loop.test.ts src/orchestrator/execution/__tests__/task-verifier-guards.test.ts`
- `npm run typecheck`
- `npm run lint:boundaries` (exit 0; existing warnings only)
- `npm run test:changed`

Review:
- Fresh review agent: no material findings.
