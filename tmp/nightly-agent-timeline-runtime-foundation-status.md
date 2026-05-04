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
