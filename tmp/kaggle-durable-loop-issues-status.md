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

PR:
- #1097 merged after CI passed.

## #1091

Status: implementation verified locally; preparing PR.

Plan:
- Synthesize a goal-scoped artifact metric datasource during `ObservationEngine.observe()` when the goal has a `workspace_path:` constraint.
- Scope the synthetic datasource to numeric goal dimensions and map each observed dimension name to the same artifact metric key, so plain metric names like `roc_auc` can match `metric_name: "roc_auc"` with `cv_score`/`score`.
- Include `experiments` in builtin artifact metric search roots.
- Make goal-scoped artifact metric observation fall through to LLM only when no matching artifact metric is found or parsed.
- Add adapter coverage for `experiments/**/metrics.json` and production-path observation coverage with daemon state dir different from the goal workspace.

Implemented:
- `ObservationEngine.observe()` now synthesizes a goal-scoped artifact metric datasource from goal `workspace_path:` when no registered datasource already serves the numeric dimension.
- Builtin artifact metric scanning now includes `experiments`.
- Goal-scoped artifact metric datasources require a matching metric, so missing/unparseable artifacts fall through to LLM instead of persisting a mechanical zero.
- Plain metric dimensions such as `roc_auc` map to `metric_name: "roc_auc"` with `cv_score` / `score` extraction.

Verification:
- `npm test -- --run src/adapters/__tests__/artifact-metric-datasource.test.ts src/platform/observation/__tests__/observation-engine.test.ts`
- `npm run typecheck`
- `npm run lint:boundaries` (exit 0; existing warnings only)
- `npm run test:changed`

Review:
- Fresh review found a production-path test gap: the goal-workspace observation test did not include the daemon/setup builtin datasource.
- Fixed the test to construct `ObservationEngine` with `createWorkspaceArtifactMetricDataSource(daemonWorkspace)` and assert the goal workspace metric wins.
- Second fresh review found a remaining workspace-scoping gap for builtin-supported artifact dimensions when the daemon datasource already claims the dimension.
- Fixed goal datasource synthesis to always prefer the goal workspace for numeric workspace goals, while only adding explicit metric mappings for plain metric names like `roc_auc`; added a `best_oof_balanced_accuracy` regression with a wrong daemon metric.
- Final fresh review: no high-confidence material defects.
