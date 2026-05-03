# Shared Agent Timeline Status

## 2026-05-03 - startup
- Ran `git switch main && git pull --ff-only`: main was already current with origin/main.
- Ran `gh issue list --state open --limit 100`: #945, #946, #947, #948, #949 are all open; newer open issues are intentionally ignored for this batch.

## #945 plan
- Define a typed, channel-agnostic timeline contract separate from TUI rendering.
- Add an AgentLoopEvent -> shared timeline projection that preserves started/resumed/turn_context/model_request/commentary/tool/plan/approval/compaction/final/stopped ordering without terminal-only fields.
- Bridge the projected timeline into chat events as the initial production consumer while keeping existing assistant final streaming compatible.
- Add caller-path coverage for agent-loop events reaching chat/TUI message state through shared timeline events.
- #945 verification so far: focused chat-event-state/chat-runner tests passed; `npm run typecheck` passed; `npm run lint:boundaries` exited 0 with existing warnings only.
- #945 review: first review found duplicate final/stopped timeline rendering; fixed by making timeline rows transient and coalescing them before assistant final/lifecycle end. Second review found transient overflow could evict durable chat history; fixed cap trimming to drop transient rows before durable rows and added regression coverage. Final review LGTM.
- #945 final verification: focused tests passed (114 tests), `npm run typecheck` passed, `npm run lint:boundaries` exited 0 with existing warnings, `npm run test:changed` passed (20 files passed, 2 skipped; 438 tests passed, 2 skipped).

## #946 plan
- Confirmed #946 is open after syncing main.
- Add explicit agent-loop prompt/profile guidance requiring short user-facing commentary before major phases: initial orientation, after broad exploration, before edits, before verification, and approach changes.
- Keep commentary as `assistant_message` / shared timeline `assistant_message` items, separate from tool rows and future deterministic summaries.
- Add caller-path coverage for `commentary -> tool start -> tool result -> commentary -> final` through the chat event bridge and chat state consumer, plus no-commentary compatibility.
- #946 verification: focused commentary/chat prompt tests passed (28 tests), `npm run typecheck` passed, `npm run lint:boundaries` exited 0 with existing warnings, review agent LGTM, `npm run test:changed` passed (31 files passed, 3 skipped; 476 tests passed, 3 skipped).

## #947 plan
- Confirmed #947 is open after syncing main.
- Remove user-facing `Current activity` / `Recent activity` aggregation from chat/TUI state.
- Render shared timeline tool/commentary/approval/final items as chronological transcript rows with normal retention, not latest-five activity retention.
- Keep raw/debug events available by continuing to emit structured chat events, while normal transcript rendering uses shared timeline rows.
- #947 verification: focused chat state/chat runner tests passed (117 tests), `npm run typecheck` passed, `npm run lint:boundaries` exited 0 with existing warnings, review agent LGTM, `npm run test:changed` passed (20 files passed, 2 skipped; 441 tests passed, 2 skipped).
