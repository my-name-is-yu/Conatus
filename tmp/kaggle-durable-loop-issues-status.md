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

PR:
- #1096 merged after CI rerun. Initial integration failure was unrelated `loop-supervisor` timing; exact file passed locally and rerun passed.

## #1090

Status: implementation verified locally; preparing PR.

Plan:
- Catch `soilPrefetch` failures in `AgentLoopContextAssembler` and return empty Soil context with a warning so task execution can continue.
- Keep vector search failures non-fatal in `searchCrossGoalLessons()` by falling back to existing non-vector lesson selection.
- Add focused native task runner coverage where Soil/vector prefetch throws `OpenAI embedding request failed: 401 Unauthorized` and bounded runner is reached.
- Add bounded provider/embedding preflight to `doctor` that warns on invalid/expired embedding auth without exposing key material.

Implemented:
- Agent-loop context assembly now converts Soil prefetch exceptions into grounding warnings and continues with empty Soil context.
- Cross-goal lesson search catches vector search failures and falls back to existing manifest/text lesson search.
- `pulseed doctor` now resolves OpenAI embedding auth through the same provider `.env`/provider config path and probes the embeddings endpoint with a bounded timeout.
- Doctor warning paths avoid logging key material.

Verification:
- `npm test -- --run src/orchestrator/execution/agent-loop/__tests__/task-agent-loop-runner.test.ts src/platform/knowledge/__tests__/memory-lifecycle-phase2.test.ts src/interface/cli/__tests__/cli-doctor.test.ts src/base/llm/__tests__/provider-config.test.ts`
- `npm run typecheck`
- `npm run lint:boundaries` (exit 0; existing warnings only)
- `npm run test:changed`

Review:
- Initial fresh review found two preflight issues; both fixed.
- Second fresh review: no material findings.
