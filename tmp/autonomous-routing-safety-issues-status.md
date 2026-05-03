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
- Pending until #914 is merged.
