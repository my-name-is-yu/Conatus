# Nightly agent timeline/runtime foundation status

## 2026-05-04
- Startup: `git switch main && git pull --ff-only` succeeded; main was already up to date.
- Startup: `gh issue list --state open --limit 100` confirmed #957, #956, and #935 are open. Other open issues are treated as out of scope unless they block these three.

## #957 Move agent timeline activity classification into tool metadata
- Status: in progress.
- Plan: add typed `activityCategory` to `ToolMetadata`, carry it on agent-loop tool events, prefer it in shared timeline summaries, keep command-string parsing only for explicit shell/command protocol input, and update core/default tool metadata plus focused tests.
- Implementation: added `ToolMetadata.activityCategory`, propagated it on tool loop events, updated shared timeline classification to prefer metadata, retained explicit command-string parsing for shell/command calls, and added core builtin metadata for search/read/write/test/command tools.
- Verification so far: focused timeline/types Vitest passed; `npm run typecheck` passed.
- Verification: focused runner/timeline/types Vitest passed after adding event propagation coverage; `npm run typecheck` passed again; `npm run lint:boundaries --if-present` exited 0 with existing warnings.
- `npm run test:changed --if-present` failed in unrelated Telegram setup guidance expectations while using existing `.pulseed-sandbox` state; failing assertions expected unconfigured setup guidance but output reported configured Telegram config/home chat. No changed files in #957 touch that path.
- Review: fresh review agent started for material issue review.
- Review finding addressed: added activity metadata to additional builtin search/read tools that previously relied on name-based classification (`code_search`, `code_search_repair`, `code_read_context`, `json_query`, `skill_search`, `knowledge_query`).
- Review: second fresh review completed with no findings.
- Status: ready for commit/PR.

## #956 Expose shared agent timeline to non-TUI channels
- Status: in progress.
- Plan: use Telegram gateway as the smallest production-facing non-TUI vertical slice; reuse the shared `agent_timeline` ChatEvent payload directly, render compact user-visible timeline text from the shared item, and stop rendering suppressed legacy tool_* events in Telegram so raw/debug tool traces stay separate from normal channel output.
- Implementation: exported the shared chat timeline renderer and wired Telegram gateway `ChatEvent` handling to render `agent_timeline` items directly. Telegram now ignores `tool_*` events marked `presentation.suppressTranscript`, keeping raw/debug tool traces separate from normal channel output while using the shared event contract.
- Test added: Telegram gateway production-facing path builds shared timeline ChatEvents from `ChatRunnerEventBridge`/agent-loop events and verifies commentary, tool start/finish, activity summary/final, approval, and compaction render without internal labels.
- Verification so far: focused Telegram gateway/chat event state Vitest passed; `npm run typecheck` passed.
- Verification: `npm run lint:boundaries --if-present` exited 0 with existing warnings.
- `npm run test:changed --if-present` failed in unrelated/shared-environment paths: daemon e2e could not bind 127.0.0.1:41700 (EADDRINUSE), and one Telegram cleanup assertion failed with ENOTEMPTY in that run. Re-running `npx vitest run --config vitest.integration.config.ts src/runtime/gateway/__tests__/telegram-gateway-adapter.test.ts` passed.
- Review finding addressed: Telegram marks shared `agent_timeline` final rows as assistant output so fallback replies are suppressed; test now asserts fallback text is not sent.
- Review finding addressed: final timeline fallback suppression now happens before awaiting Telegram send, with an async-drain regression test for `agent_timeline` final delivery.
- Stability fix: Telegram gateway test cleanup now retries temp-dir removal, and async `agent_timeline` final test covers the fallback race directly.
- Review finding addressed: Telegram suppresses `operation_progress` rows derived from `agent_timeline_activity_summary`, relying on the shared `agent_timeline` summary rendering; test now asserts the internal title does not appear.
- Review finding addressed: Telegram no longer renders shared `agent_timeline` final rows as separate messages; final timeline rows only mark assistant output as present to suppress fallback, leaving production assistant_final rendering as the single final reply.
- Review: final fresh review completed with no findings.
- Status: ready for commit/PR.
