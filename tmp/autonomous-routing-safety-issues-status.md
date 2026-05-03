# Autonomous Routing Safety Issues Status

## 2026-05-03

### Initial sync
- Ran `git switch main && git pull --ff-only`: main was already up to date with `origin/main`.
- Ran `gh issue list --state open --limit 100`: #914 and #912 are both open.
- Read #914 and #912 with `gh issue view --json`.

### Issue #914 plan
- Branch: `codex/issue-914-self-source-protection`.
- Scope: add explicit consumer/dev execution profile with `PULSEED_DEV=1` opt-in, protect PulSeed package/source roots from agent-loop writes in consumer mode, keep setup/config writes under `~/.pulseed` outside this guard, and show dev mode in CLI-visible profile posture.
- Production path: enforce via `ExecutionPolicy.protectedPaths` consumed by file write/edit validation, apply-patch validation, and shell command assessment.
- Tests: cover production agent-loop tool runtime calls for normal-mode block and dev-mode allow, plus setup/config path unaffected through direct config write flow where feasible.
- Blockers: none yet.

### Issue #914 implementation status
- Added `consumer` / `dev` execution profile resolution. `PULSEED_DEV=1` and global CLI `--dev` opt into dev profile.
- In consumer profile, `ExecutionPolicy.protectedPaths` now includes PulSeed package/source roots and optional `PULSEED_SELF_PROTECTION_ROOTS` test/override roots.
- Agent-loop production tool path now blocks protected root mutation through `apply_patch`, `file_write` / `file_edit` existing path validation, and `shell_command` mutating commands including explicit protected-path targets.
- Dev profile leaves protected roots empty, so the same mutation path is allowed.
- CLI goal status prints `Execution profile: dev` when dev mode is active.
- Setup/config updates under `~/.pulseed` are not added to protected roots; existing direct setup/config write paths remain outside the new agent-loop source protection gate.
- Verification so far:
  - `npx vitest run src/orchestrator/execution/agent-loop/__tests__/agent-loop-phases-3-7.test.ts src/tools/__tests__/permission.test.ts` passed.
  - `npm run typecheck` passed.
  - `npm run lint:boundaries` passed with pre-existing warnings.
  - `npm run test:changed` passed.
- Review agent found two material bypasses: interpreter-based shell writes from protected cwd and unified delete patches. Both were fixed and covered by tests.

### Issue #912 plan
- Branch: `codex/issue-912-setup-help-routing`.
- #914 dependency completed: PR #944 merged with green `unit (22)` and `integration (24)`.
- Scope: add a typed freeform semantic routing contract before coding agent-loop execution, using structured LLM classification with confidence/clarification instead of keyword/includes logic.
- Route classes: `assist`, `configure`, `execute`, `clarify`.
- Configure route will return actionable setup guidance for Telegram/gateway setup without launching agent-loop.
- Tests: ChatRunner production route tests for Japanese/English Telegram setup and ambiguous clarification, explicit execute still entering agent-loop, and a TUI caller-path test proving freeform input reaches ChatRunner rather than direct lower-level execution.
- Blockers: none yet.

### Issue #912 implementation status
- Added `FreeformRouteIntentSchema` and an LLM-backed pre-agent route classifier for freeform ChatRunner input.
- `IngressRouter` now accepts typed freeform route intent and selects `assist`, `configure`, `clarify`, or existing execution routes before coding agent-loop handoff.
- `configure` returns actionable Telegram/gateway/setup guidance without invoking the coding agent loop; `clarify` asks for setup/config/code intent; `assist` stays read-only through the LLM response path.
- Added ChatRunner production routing tests for Japanese and English Telegram setup requests, ambiguous clarification, and explicit implementation still entering agent-loop.
- Added a TUI caller-path test confirming freeform Telegram setup input reaches the production ChatRunner entrypoint.
- Verification so far:
  - `npm run typecheck` passed.
  - `npx vitest run src/interface/chat/__tests__/chat-runner.test.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/tui/__tests__/app.test.ts` passed.
  - `npm run lint:boundaries` passed with pre-existing warnings.
  - `npm run test:changed` passed.
  - `git diff --check` passed.
- Review: fresh review agent found a cross-platform gateway bypass and weak TUI route coverage. Fixed by passing `freeformRouteIntent` through `CrossPlatformChatSessionManager`, adding a Telegram gateway production session regression test, and strengthening the TUI test to execute a real ChatRunner route.
- Additional regression update: `chat-boundary-contract` now accounts for the new freeform execute pre-route while preserving latest reply-target runtime-control behavior.
