# Resident Channel Readiness Status

## #987 Expose channel, session, and runtime binding status for operators
- Status: in progress
- Branch: codex/issue-987-operator-bindings-status
- Initial sync: main was up to date; target issue #987 is open as of 2026-05-03.
- Plan: inspect existing CLI/runtime status surfaces, add one typed operator binding status collector/formatter, cover configured inactive, active home chat, missing runtime-control allowlist, and background run pinned reply target.
- Implementation: added `pulseed runtime bindings` typed JSON/text status surface using runtime session registry, background run ledger projection, daemon running state, runtime health snapshot, and gateway channel config files.
- Verification: `npm run typecheck` passed; `npm test -- src/interface/cli/__tests__/runtime-command.test.ts --runInBand` passed (npm warned runInBand is unknown but Vitest lane passed).
- Notes: no durable per-channel health store exists yet; active means valid channel config + daemon running + gateway component health ok. Missing home chat and missing runtime-control allowlists are warnings.
- Verification: `npm run lint:boundaries` exited 0 with pre-existing warnings only.
- Review: separate review agent found two material gaps: custom daemon runtime root and missing configured goal bindings.
- Fix after review: `runtime bindings` now resolves configured daemon runtime root for health/background-run ledger and exposes conversation/sender/default goal bindings; focused test covers custom runtime root and chat_goal_map output.
- Verification after review fixes: focused runtime CLI test passed again; `npm run typecheck` passed; `npm run lint:boundaries` exited 0 with existing warnings.
- Second review: found non-Telegram partial config could be misreported active.
- Fix after second review: built-in non-Telegram channels now validate required transport fields before active; partial Discord config is covered as degraded.
- Verification after second review fix: focused runtime CLI test passed (19 tests); `npm run typecheck` passed.
- Verification after required-fields fix: `npm run lint:boundaries` exited 0 with existing warnings only.
- Verification: `npm run test:changed` passed (11 files, 246 tests).
- Status: implementation complete; preparing commit and PR.

## #985 Polish Telegram daily-use onboarding and safe home-chat binding
- Status: in progress
- Branch: codex/issue-985-telegram-onboarding
- Initial sync: main up to date; issue #985 is open as of 2026-05-03.
- Plan: inspect Telegram setup/gateway paths, make unrestricted setup explicit, add safe first sender/home binding state, expose Telegram permissions/home/runtime-control through runtime bindings, and add focused production-path tests.
- Implementation: Telegram setup now keeps access closed when allowed users are blank unless unrestricted mode is explicitly confirmed; CLI config writes runtime-control allowlist separately.
- Implementation: first locked `/sethome` from Telegram binds home chat and the first normal-chat allowed user without granting runtime-control permission.
- Implementation: `runtime bindings` now exposes normal chat access allow_all/allowed count alongside runtime-control count.
- Verification: focused Telegram/setup/runtime status tests passed; `npm run typecheck` passed.
- Review: separate review agent found runtime-control status/permissions were not separated enough and last inbound/outbound health was missing.
- Fix after review: runtime-control allowlist now has separate prompts/config; `allow_all` no longer implies runtime-control; Telegram adapter persists last inbound/outbound/error health next to config and `runtime bindings` exposes it.
- Verification after review fixes: focused Telegram/gateway/setup/runtime tests passed (46 tests).
- Verification after runtime-control/health fixes: `npm run typecheck` passed; `npm run lint:boundaries` exited 0 with existing warnings only.
- Verification: `npm run test:changed` passed after adapter stop/health cleanup fix.
- Review: second review agent reported no material findings after runtime-control and health fixes.
- Status: implementation complete; preparing commit and PR.
