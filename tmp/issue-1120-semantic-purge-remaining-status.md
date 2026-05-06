# Issue #1120 Semantic Purge Remaining Status

## Startup

- Base repository synced to `origin/main` at `6d8b3842`.
- Worktree: `/Users/yuyoshimuta/Documents/dev/PulSeed-worktrees/issue-1120-semantic-purge-remaining`.
- PR #1159 is merged and present on `main`.
- PR #1161 is merged and present on `main`; no open PRs were reported by `gh pr list --state open --limit 50`.
- `tmp/wave1-semantic-purge-audit.md` is present and was read.

## Child Issues

- #1162 `refactor(semantic): route shell safety and TUI bang execution through typed tool policy`
  - Parent: #1120
  - Risk lane: auth-security + runtime-state
  - Execution lane: serial
  - Mode: independent PR
- #1163 `refactor(semantic): replace agent-loop command-result evidence classification with typed tool/result metadata`
  - Parent: #1120
  - Risk lane: shared-api-schema + runtime-state
  - Execution lane: serial
  - Mode: independent PR after checking #1159 is on main
- #1164 `refactor(semantic): replace agent-loop error-text fallback with typed failure reasons`
  - Parent: #1120
  - Risk lane: runtime-state
  - Execution lane: serial
  - Mode: independent PR
- #1165 `refactor(semantic): replace chat context keyword grep with typed context query planning`
  - Parent: #1120
  - Risk lane: shared-api-schema
  - Execution lane: serial
  - Mode: independent PR
- #1166 `refactor(semantic): remove runtime typed-field text fallbacks`
  - Parent: #1120
  - Risk lane: runtime-state
  - Execution lane: serial
  - Mode: independent PR
- #1167 `refactor(semantic): type artifact retention metadata before cleanup decisions`
  - Parent: #1120
  - Risk lane: persistence-migration + runtime-state
  - Execution lane: serial
  - Mode: independent PR, or blocked if a shared artifact schema migration is required

## Active Slice: #1162

- Branch: `codex/issue-1162-shell-policy`
- Base branch: `main`
- Base SHA at start: `6d8b3842932a54a9d4b917ca8f69e6c3585e9a50`

Implementation plan:

1. Replace regex shell safety lists in `src/tools/system/ShellTool/command-policy.ts` with a deterministic command analyzer that emits typed capabilities for read-only, local-write, network, destructive, and protected-target outcomes.
2. Reuse the typed analyzer from `ShellTool`, `ShellCommandTool`, `ToolExecutor` sanitization, `ShellTool.isConcurrencySafe`, and TUI/CLI safe-shell allow rules.
3. Remove the direct trusted/preapproved TUI `!` path in `src/interface/tui/app.tsx`; execute `!` commands through `ToolExecutor` with `preApproved: false`, a real approval adapter, and a default execution policy.
4. Add focused tests for typed shell policy outcomes and a production TUI caller path that proves `resolveTuiInputAction` to `App` to `ToolExecutor` does not bypass approval.

Implementation summary:

- Replaced shipped regex safe/write/network/destructive shell policy lists with a deterministic shell-token analyzer that produces typed shell capabilities.
- Routed `ShellTool.isConcurrencySafe`, TUI/CLI `isSafeBashCommand`, `ShellCommandTool` apply-patch blocking, and `ToolExecutor` shell sanitization through the same typed analyzer.
- Removed direct trusted/preapproved `ShellTool.call` from TUI bang execution. TUI `!` commands now execute through `ToolExecutor` with `preApproved: false`, typed execution policy, and approval queue bridging.
- Added TUI caller-path tests for safe read-only execution, approval-denied writes, and quoted command-substitution denial before approval/process execution.

Review:

- Fresh review found a P1 command-substitution bypass inside double quotes.
- Fixed by rejecting `$(` and backticks inside double-quoted shell text, then added unit and TUI production-caller regression coverage.

Validation:

- `npx vitest run --config vitest.unit.config.ts src/tools/system/ShellTool/__tests__/ShellTool.test.ts src/tools/__tests__/execution-orchestrator.test.ts src/tools/__tests__/executor.test.ts src/tools/__tests__/workspace-actions.test.ts --reporter verbose` - passed, 84 tests.
- `npx vitest run --config vitest.integration.config.ts src/interface/tui/__tests__/app.test.ts src/interface/tui/__tests__/chat.test.ts --reporter verbose` - passed, 72 tests.
- `npm run typecheck` - passed.
- `npm run lint:boundaries` - passed with existing warnings only: 0 errors, 657 warnings.
- `npm run test:changed` - passed: related unit 51 files passed / 3 skipped, 869 passed / 3 skipped; related integration 11 files passed, 132 passed; smoke 8 files passed, 204 passed.
- `git diff --check` - passed.

## PR Readiness Manifest

- pr: pending
  issues: [1162]
  mode: independent
  risk_lanes: [auth-security, runtime-state]
  head_branch: codex/issue-1162-shell-policy
  base_branch: main
  base_sha_at_handoff: 8611d9272048e2147f0f22abf1c0a14c8e15307d
  head_sha_at_handoff: unknown
  stack_parent: none
  stack_order: none
  replay_required: false
  replay_plan: none
  replay_owner: none
  validation:
    - npx vitest run --config vitest.unit.config.ts src/tools/system/ShellTool/__tests__/ShellTool.test.ts src/tools/__tests__/execution-orchestrator.test.ts src/tools/__tests__/executor.test.ts src/tools/__tests__/workspace-actions.test.ts --reporter verbose: passed
    - npx vitest run --config vitest.integration.config.ts src/interface/tui/__tests__/app.test.ts src/interface/tui/__tests__/chat.test.ts --reporter verbose: passed
    - npm run typecheck: passed
    - npm run lint:boundaries: passed with existing warnings only
    - npm run test:changed: passed
    - git diff --check: passed
  ci_state_observed: not-run
  review_state_observed: findings-fixed
  machine_review_signals: present
  unresolved_risks: []
  human_action_required: false
  next_action: check-merge
