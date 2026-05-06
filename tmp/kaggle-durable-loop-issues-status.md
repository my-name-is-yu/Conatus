# Kaggle Durable Loop Issues Status

Updated: 2026-05-06 Asia/Tokyo

## Startup

- Ran `git switch main && git pull --ff-only`: already on up-to-date `main`.
- Ran `gh issue list --state open --limit 100`: target issues #1089, #1090, #1091, and #1093 are open.
- New adjacent open issues #1094 and #1095 exist, but current work remains focused on #1089/#1090/#1091/#1093 unless they become blockers.

## #1089

Status: merged via PR #1096.

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

Status: merged via PR #1097.

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

Status: merged via PR #1098.

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

PR:
- #1098 merged after CI passed.

## #1093

Status: merged via PR #1099.

Plan:
- Add an active execution abort path in `LoopSupervisor.shutdown()` with bounded wait before returning.
- Pass an `AbortSignal` through `GoalWorker.execute()` -> `CoreLoop.run()` -> task cycle -> `TaskLifecycle.runTaskCycle()` -> native `TaskAgentLoopRunner.runTask()`.
- Pass agent-loop abort into model requests and LLM clients, and make `CodexLLMClient` terminate its spawned child on abort.
- Pass tool abort signals into shell/test child execution through `execFileNoThrow`.
- Add a regression test where shutdown occurs while a worker/core loop is hung and assert shutdown returns without natural completion.

Implemented:
- `LoopSupervisor.shutdown()` now aborts tracked active executions with a bounded grace wait instead of awaiting natural completion forever.
- `GoalWorker.execute()` passes an operator-stop `AbortSignal` into `CoreLoop.run()`; `CoreLoop` propagates it through the iteration kernel, task lifecycle, and native task agent-loop execution.
- Agent-loop model clients, provider LLM clients, Codex CLI child execution, Ollama fetch, OpenAI/Anthropic SDK requests, and shell/test tool child execution now receive the abort signal where applicable.
- Shell/test command execution uses an opt-in process-group `spawn` path that terminates the group on abort/timeout where supported, with direct-child fallback; Codex CLI model child execution also starts detached where supported and kills the process group on abort/timeout.
- Abort-triggered task execution returns/stops as operator stop rather than classifying it as a normal task failure.
- Regression tests cover supervisor shutdown while active execution cooperates with abort, supervisor shutdown while active execution ignores abort, Codex CLI child termination on abort, and Ollama fetch abort propagation.

Verification:
- `npm test -- --run src/runtime/__tests__/loop-supervisor.test.ts src/base/llm/__tests__/codex-llm-client.test.ts src/base/llm/__tests__/ollama-client.test.ts`
- `npm run test:integration -- --run src/runtime/__tests__/loop-supervisor.test.ts`
- `npm run typecheck`
- `npm run lint:boundaries` (exit 0; existing warnings only)
- `npm run test:changed`

Review:
- Fresh review found four material issues: shutdown could miss execution started by an in-flight poll, tree-mode did not pass the abort signal into node execution, operator abort during model request was classified as timeout, and shell/test tool abort only killed direct children.
- Fixed shutdown ordering to wait for `currentPoll` before snapshotting/aborting active executions and added a stop guard after lease acquisition so shutdown does not start new executions from an in-flight poll.
- Fixed tree-mode to pass the same abort signal through `runTreeIteration()` into node `runOneIteration()`.
- Fixed model abort classification to `cancelled` with operator-stop text instead of timeout.
- Added process-group cleanup for shell/test command execution and Codex CLI model child execution where supported.
- Added regressions for in-flight poll stop, aborted model request classification, and process-group options for shell/test/Codex commands.
- Second fresh review found remaining issues: cancelled task execution was still mapped to error, OpenAI Responses fallback timeout timer was not cleared on abort/reject, `currentPoll` could still block before active abort, and AbortError text alone was treated as operator cancellation.
- Fixed cancelled task propagation by adding `cancelled` to task/adapter status, mapping agent-loop `cancelled` to `stopped_reason: "cancelled"`, and persisting cancelled tasks without failed/error status.
- Fixed Responses fallback timer cleanup with `finally`, bounded `currentPoll` wait using `activeStopGraceMs`, and restored non-operator AbortError classification to timeout unless the turn abort signal is actually aborted.
- Added regressions for cancelled result mapping, Responses abort timer cleanup, provider AbortError without operator abort, and stuck currentPoll shutdown.
- Re-ran focused unit tests, integration supervisor test, `npm run typecheck`, `npm run lint:boundaries`, `git diff --check`, and `npm run test:changed`; all passed. `lint:boundaries` exits 0 with existing warnings.
- Final fresh review found two remaining broad AbortError classifiers in CoreLoop and GoalWorker.
- Removed AbortError string/name classification from CoreLoop/GoalWorker cancellation paths; those boundaries now report stopped only when the propagated operator `AbortSignal` is actually aborted. Added regressions for provider AbortError staying error and operator-aborted GoalWorker errors becoming stopped.
- After final review fixes, re-ran focused unit tests, `npm run typecheck`, `npm run lint:boundaries`, `git diff --check`, and `npm run test:changed`; all passed. `lint:boundaries` exits 0 with existing warnings.

PR:
- #1099 merged after CI passed.
