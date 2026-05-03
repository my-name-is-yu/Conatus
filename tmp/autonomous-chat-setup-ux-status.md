# Autonomous chat/setup UX status

Updated: 2026-05-03

## Initial refresh
- Ran `git switch main && git pull --ff-only`: main was already up to date.
- Ran `gh issue list --state open --limit 100`: #976, #975, #974 are open. New adjacent issues #970-#967 and #957/#956 exist, but current batch remains #976 -> #975 -> #974 unless they become blockers.

## #976 language hint
- Status: in progress.
- Issue body read with `gh issue view 976`.
- Plan: add a typed turn-level language hint at chat ingress, pass it through configure/direct route formatting, add same-language prompt guidance, and test Japanese/English direct configure through the production ChatRunner path without adding keyword/regex semantic routing.
- Implemented typed `TurnLanguageHint` and routed it through ChatRunner direct configure/assist paths.
- Added Japanese Telegram configure copy while preserving protocol tokens and commands.
- Verification: `npx vitest run src/interface/chat/__tests__/turn-language.test.ts src/interface/chat/__tests__/chat-runner.test.ts -t "turn language hint|routes Japanese Telegram setup requests|routes English Telegram setup paraphrases"` passed.
- Verification: `npm run typecheck` passed.
- Verification: `npm run lint:boundaries` passed with existing warnings only (0 errors, 610 warnings).
- Review agent reported two material #976 gaps: non-Telegram configure fallback copy ignored language hint, and activity events did not carry language hints.
- Fixed both: direct configure fallbacks now render Japanese when hinted, and chat events carry `languageHint`; configure intent activity is localized for Japanese.
- Re-verification: focused Vitest passed.
- Re-verification: `npm run typecheck` passed.
- Re-verification: `npm run test:changed` passed (21 files, 460 tests; 2 skipped).
- Re-verification: `npm run lint:boundaries` passed with existing warnings only (0 errors, 610 warnings).
- Re-review after fixes: no material findings.
- PR #977 CI: `unit (22)` passed; `integration (24)` failed because `src/interface/tui/__tests__/app.test.ts` still expected the old English intent activity text.
- Fixed the integration expectation to the localized Japanese activity text and verified `npx vitest run --config vitest.integration.config.ts src/interface/tui/__tests__/app.test.ts -t "routes Telegram setup freeform input"` passed.
- Re-verification after CI fix: `npm run typecheck` passed.

## #976 language hint
- Status: merged.
- PR: #977 (`feat(chat): add turn language hints`).
- CI: `unit (22)` passed; `integration (24)` passed after updating the TUI integration expectation.

## #975 shared operation progress timeline
- Status: in progress.
- Issue body read with `gh issue view 975`.
- Plan: define typed `operation_progress` chat event/model, adapt agent-loop timeline summaries into it without breaking #949, emit deterministic setup/configure progress from direct Telegram route, render it through the existing chat event reducer/TUI path, and cover secret redaction.
- Implemented typed `operation_progress` chat events and `OperationProgressItem` model.
- Added direct Telegram configure progress producer for started/status/config/next-step states, with language hints and setup-secret redaction.
- Adapted agent-loop activity summary into the same operation progress model while preserving existing `agent_timeline` behavior.
- Added chat reducer rendering so progress remains separate from final assistant output.
- Verification: focused Vitest for operation progress/direct route/agent-loop adapter passed.
- Verification: `npm run typecheck` passed.
- Verification: `npm run test:changed` passed (20 files, 459 tests; 2 skipped).
- Verification: `npm run lint:boundaries` passed with existing warnings only (0 errors, 610 warnings).
- Review agent found P1: Telegram gateway adapter ignored `operation_progress`, so gateway users would not see incremental progress.
- Fixed Telegram gateway event adapter to render `operation_progress` via the shared renderer before final replies.
- Added Telegram gateway integration coverage for progress plus final guidance dispatch.
- Re-verification: focused Vitest for chat progress and Telegram gateway progress passed.
- Re-verification: `npm run typecheck` passed.
- Re-verification: `npm run test:changed` passed, including related unit/integration and smoke lanes.
- Re-verification: `npm run lint:boundaries` passed with existing warnings only (0 errors, 610 warnings).
- Re-review after Telegram gateway fix: no material findings.

## #975 shared operation progress timeline
- Status: merged.
- PR: #978 (`feat(chat): add shared operation progress`).
- CI: `unit (22)` passed; `integration (24)` passed.

## #974 setup copy and natural-language confirmation
- Status: in progress.
- Issue body read with `gh issue view 974`.
- Plan: suppress internal setup preamble in rendered chat output, add typed setup confirmation intent via LLM/classifier state rather than phrase tables, explicitly mark replacement when an existing token is configured, keep slash fallback, and verify Japanese/English production chat route plus redaction.
- Implemented direct configure preamble suppression by keeping configure progress on the shared `operation_progress` surface without emitting the generic `intent:first-step` activity.
- Added natural-language confirmation for pending Telegram setup writes through `classifyConfirmationDecision` using the typed setup dialogue state as the subject; `/confirm-setup-write` remains the deterministic fallback command.
- Added `replacesExistingSecret` to setup dialogue public state, surfaced replacement warnings before confirmation, and included replacement risk in the approval reason.
- Preserved secret redaction in rendered output, persisted setup dialogue state, progress metadata, and approval text.
- Added Japanese/English production ChatRunner coverage for natural-language confirmation, replacement warning coverage, and TUI coverage that rejects the internal preamble.
- Verification: focused Vitest for turn language and chat-runner setup confirmation passed.
- Verification: `npm run typecheck` passed.
- Verification: `npm run test:changed` passed, including related unit/integration and smoke lanes.
- Verification: `npm run lint:boundaries` passed with existing warnings only (0 errors, 610 warnings).
- Review agent reported no high-confidence material findings. Residual risk: natural-language confirmation quality depends on the production LLM confirmation classifier.
