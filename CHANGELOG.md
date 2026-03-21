# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.4.0] - 2026-03-21

Phase 3 development infrastructure, OSS optimization (#112-#146, 35 items), hierarchical memory Phase 2, and Node.js 18 end-of-life drop. Test suite: 4315 tests, 196 test files.

### Added

- Added hierarchical memory Phase 2: three-tier storage (core / recall / archival), LLM-driven page-in/out, cross-tier promotion and demotion, dynamic context budgeting, and archival semantic search.
- Added Browser Use CLI adapter for browser-automation task delegation.
- Added A2A protocol adapter for agent interoperability.
- Added structured Reflexion-style reflection with task-lifecycle split.
- Added 4-point guardrail callbacks (before/after execution and before/after LLM call).
- Added LLM fault-tolerance guards (10 guards across 6 modules) covering enum sanitization, direction-check on `dimension_updates`, and Zod validation of `autoDetectDependencies` responses.
- Added custom Error class hierarchy for better error classification and stack filtering (closes #123).
- Added LLM provider enhancements with an `ensure-api-key` CLI helper for interactive key setup.
- Added `SECURITY.md`, competitor comparison table, and OSS-quality README badges.
- Added hypothesis verification mechanism (Milestone 14 follow-up).
- Added convergence detection to `SatisficingJudge`.
- Added consolidated reward-computation JSON log and completion-judger timeout/retry config.

### Changed

- Dropped Node.js 18 support (EOL April 2025); minimum runtime is now Node.js 20.
- Phase 3 file-splitting: 11 large files (700–1400 lines) split into 30+ focused modules; all modules are now under 500 lines.
- Migrated all synchronous `fs.*` calls to `fs/promises` across 28+ modules for consistent async I/O.
- Centralized environment-variable references to `provider-config.ts` and JSON I/O to `json-io.ts` (closes #120, #125).
- Replaced Markdown regex re-parsing with structured metadata in `ReportingEngine` (closes #142).
- Extracted `BaseLLMClient` with shared `safeParse` logic from four LLM clients (closes #112, #119).
- Skipped retry on 4xx client errors in `LLMClient` to avoid wasting quota on permanent failures (closes #134).
- Translated plugin-loader error messages to English (closes #143).
- Reorganized `src/` root (48 files) into 9 subdirectories; 45 files relocated.
- Test suite run time reduced from ~565 s to ~8 s through async-mock fixes and slow-test elimination.
- `docs/status.md` translated to English for OSS readability.

### Fixed

- Fixed Critical OSS issues: URL inconsistency across docs (#159), remaining Node.js 18 references (#160), duplicate Node.js 18 CI matrix entries (#161), and missing `.gitignore` entries for generated artifacts (#166).
- Fixed path traversal vulnerability in `StateManager.readRaw/writeRaw` (closes #126).
- Fixed shell-binary denylist enforcement in `ShellDataSourceAdapter` argv[0] (closes #145).
- Fixed sensitive-directory denylist in `workspace-context` to prevent credential leakage (closes #140).
- Fixed goalId sanitization in `DaemonRunner.generateCronEntry` (closes #146).
- Fixed `execFileSync` replaced with async `execFile` in observation-llm to avoid blocking the event loop (closes #130).
- Fixed infinite stream-reopen loop in Logger (closes #139).
- Fixed `activateMultiple` partial mutation on validation failure (closes #141).
- Fixed broken `addEdge` call in goal-dependency graph so cycle detection works correctly (closes #129).
- Fixed `mkdtempSync` replaced with async `mkdtemp` in `CodexLLMClient` (closes #144).
- Fixed unawaited `saveReport` call in `ReportingEngine.generateNotification` (closes #128).
- Fixed unawaited `recordRebalance` in `PortfolioManager` early-return path (closes #127).
- Fixed `TrustManager` wiring in core-loop reward logging (closes #115).
- Fixed silent error swallowing in 6 core-loop catch blocks and 3 other modules with proper Logger calls (closes #116, #117, #132).
- Fixed strategy ranking to use the correct `hypothesis` key in `StrategyManagerBase` (closes #131).
- Fixed `ENOTEMPTY` race condition in `TreeLoopOrchestrator` cleanup on test teardown.
- Fixed `node:crypto` import for Node.js compatibility in test files.

### Removed

- Removed duplicate wildcard re-exports from `index.ts` (closes #118).
- Removed redundant `observeForTask` duplicate; delegated to `_observeForTask` (closes #136).
- Removed redundant embedding call in `StrategyTemplateRegistry` (closes #137).
- Removed unused `goalDescription` parameter from `matchPluginsForGoal` (closes #121).

## [0.3.0] - 2026-03-16

Milestone 7 delivery: recursive Goal Tree phase 2, cross-goal portfolio phase 2, and learning pipeline phase 2. 163 new tests (3105 → 3268, 89 test files).

### Added

- Added concreteness scoring (`scoreConcreteness()`) with LLM-based 4-dimension evaluation and auto-stop decomposition when the concreteness threshold is reached, plus maxDepth enforcement (default: 5).
- Added decomposition quality metrics (`evaluateDecompositionQuality()`) covering coverage, overlap, actionability, and depth efficiency, with reason-tracked pruning (`pruneSubgoal()`, `getPruneHistory()`) and auto-reverting restructure.
- Added momentum allocation (`calculateMomentum()`) with velocity and trend detection, dependency scheduling via topological sort and critical path analysis, and stall-triggered resource rebalancing (`rebalanceOnStall()`).
- Added embedding-based template recommendation (`indexTemplates()`, `recommendByEmbedding()`, `recommendHybrid()`) combining tag scoring and vector similarity for strategy selection.
- Added 4-step structural feedback recording (`recordStructuralFeedback()`) for observation accuracy, strategy selection, scope sizing, and task generation, with feedback aggregation and parameter auto-tuning suggestions.
- Added cross-goal pattern sharing (`extractCrossGoalPatterns()`, `sharePatternsAcrossGoals()`) with persistent storage and retrieval in KnowledgeTransfer.

## [0.2.0] - 2026-03-16

Latest release covering the last five commits, including Milestone 4 and 5 delivery, dogfooding-driven fixes, expanded documentation, and broader end-to-end validation.

### Added

- Added persistent runtime phase 2 capabilities, including graceful daemon shutdown, interrupted goal state restoration, date-based log rotation, and event-driven loop wakeups.
- Added semantic embedding phase 2 support with a shared knowledge base, vector search for implicit knowledge reuse, Drive-based memory management, semantic working-memory selection, and dynamic context budgeting.
- Added SMTP email delivery via `nodemailer` in place of the previous stub implementation.
- Added new end-to-end coverage for daemon lifecycle behavior, semantic memory flows, shared knowledge retrieval, and multi-goal integration scenarios.
- Added new contributor guidance in `CONTRIBUTING.md` generated through dogfooding.

### Changed

- Improved autonomous iteration behavior during dogfooding by tuning model temperature and lowering auto-progress sensitivity to better detect meaningful context changes.
- Improved progress stability with monotonic scoring controls that prevent score backsliding during repeated evaluations.
- Improved changelog and contributing documentation quality through self-hosted validation runs.

### Fixed

- Fixed overly aggressive file existence auto-registration by guarding it for non-`FileExistence` dimensions.
- Fixed progress oscillation during iterative evaluation by enforcing a minimum threshold for score regression handling.
- Fixed daemon runtime reliability issues around shutdown handling, restoration flow, and interruptible background waiting.

## [0.1.0] - 2026-03-16

Initial `0.1.0` release with workspace-aware execution improvements, broader automated test coverage, CLI and documentation updates, and core loop reliability fixes.

### Added

- Added workspace context support with goal-aware file selection and the ability to read files outside the workspace for richer task context.
- Added automatic registration of `file_existence` data sources after goal negotiation to improve follow-up observation coverage.
- Added comprehensive end-to-end and integration coverage for adapter execution, feedback loops, workspace context, provider validation, and CLI data-source behavior.
- Added a minimum-iteration control to the core loop so execution is guaranteed to reach at least one task cycle before declaring completion.
- Added npm publishing metadata and packaging support, including `exports`, license and author fields, and a dedicated `.npmignore`.

### Changed

- Improved CLI behavior by making the `--yes` flag position-independent and ensuring it skips confirmation prompts consistently, including archive and counter-proposal flows.
- Improved CLI stability and execution reporting so progress, archive handling, and failure modes are clearer during runs.
- Improved README and contributor documentation with npm installation, provider setup, programmatic usage, and contribution guidance.

### Fixed

- Fixed a core-loop short circuit that could declare completion before the task cycle executed.
- Fixed duplicate goal-negotiation dimension keys by deduplicating generated dimension identifiers.
- Fixed provider setup failures earlier by validating API keys during provider creation instead of failing deeper in execution.
- Fixed archived goal handling by adding archive fallback loading while keeping auto-archive disabled by default.
