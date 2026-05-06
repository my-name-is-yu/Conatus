# Wave 1 Semantic Purge Audit

## Summary

This Wave 1 pass is audit/report only for #1120. No semantic routing code was changed or removed.

I started from the required mechanical sweep for `includes(`, `.match(`, `.test(`, `RegExp`, `keyword`, `title`, `label`, `startsWith`, and `endsWith`, then filtered findings through production caller paths. The strongest purge candidates are not the current high-level freeform chat/router classifiers: those paths mostly use structured LLM schemas, typed route objects, confidence thresholds, and exact command grammar. The remaining shortcuts cluster around shell command safety/activity classification, command-result evidence classification, context gathering, derived runtime/dashboard labels, artifact retention, and error text fallback.

The main freeform ingress path currently favors typed boundaries:

- `src/interface/chat/chat-runner.ts:385` handles exact resume commands before ordinary routing.
- `src/interface/chat/chat-runner.ts:409` handles slash commands before route selection.
- `src/interface/chat/chat-runner.ts:754` derives route inputs from structured classifiers and then calls the router.
- `src/interface/chat/ingress-router.ts:110` receives `_text` but makes decisions from typed route dependencies.
- `src/interface/chat/freeform-route-classifier.ts:5` defines a schema for freeform route intent and explicitly says to use semantic intent rather than literal phrase matching at `src/interface/chat/freeform-route-classifier.ts:49`.
- The gateway/cross-platform chat path has a separate production dispatch in `src/interface/chat/cross-platform-session.ts:798`. It redacts setup secrets at `src/interface/chat/cross-platform-session.ts:810`, derives freeform route intent at `src/interface/chat/cross-platform-session.ts:835`, derives runtime-control intent at `src/interface/chat/cross-platform-session.ts:838`, derives RunSpec drafts at `src/interface/chat/cross-platform-session.ts:858`, and calls the same route selector with typed dependencies at `src/interface/chat/cross-platform-session.ts:875`.

## Definite Freeform Semantic Shortcuts

1. Shell command safety and capability policy is regex-list driven.

   `src/tools/system/ShellTool/command-policy.ts:17` defines safe command regexes, `src/tools/system/ShellTool/command-policy.ts:26` defines local-write regexes, `src/tools/system/ShellTool/command-policy.ts:33` defines network regexes, `src/tools/system/ShellTool/command-policy.ts:38` defines destructive regexes, and `src/tools/system/ShellTool/command-policy.ts:44` defines blocked command regexes. These drive allow/deny/approval decisions in `assessShellCommand` at `src/tools/system/ShellTool/command-policy.ts:64`.

   The `!` shell surface itself is exact protocol grammar, but the safety decision is a shipped regex classifier over shell text. After the Codex-like tool boundary exists, this should move behind a host/tool policy contract with typed capabilities, parser-backed command metadata where available, and fail-closed approval behavior.

2. TUI direct `!` shell execution bypasses the tool permission boundary and duplicates regex safe-command classification.

   `src/interface/tui/input-action.ts:52` routes any non-empty `!` input to `kind: "shell"`. `src/interface/tui/bash-mode.ts:14` defines `isSafeBashCommand` with another safe command regex list. `src/interface/tui/app.tsx:613` then executes `action.kind === "shell"` by constructing `ShellTool` directly with `preApproved: true`, `approvalFn: async () => true`, and `trusted: true` at `src/interface/tui/app.tsx:616`.

   `src/tools/system/ShellTool/ShellTool.ts:33` executes the shell command in `call`, while `checkPermissions` is a separate method at `src/tools/system/ShellTool/ShellTool.ts:59`; the direct TUI call path does not show that permission check being invoked. The exact `!` command grammar can remain deterministic, but Wave 2 should consolidate safety and approval through the same typed tool policy boundary used by agent-loop tool execution.

3. Chat/TUI tool activity labels are inferred from command and tool-name substrings.

   `src/interface/chat/chat-event-state.ts:171` classifies commands as reading/verifying/editing/running with regexes, and `src/interface/chat/chat-event-state.ts:185` classifies tool names with substring checks such as plan/write/edit/test/read/search/status. `src/orchestrator/execution/agent-loop/agent-timeline.ts:301` uses an `activityCategory` when supplied, but falls back to command parsing; `src/orchestrator/execution/agent-loop/agent-timeline.ts:314` maps command text into search/read/test/command buckets using executable names and test regexes.

   This is a user-facing status/dashboard decision. After #1110 provides canonical response/tool items, tool activity should come from structured tool metadata or typed result categories, not inferred labels.

4. Agent-loop command evidence classification is regex/prefix driven.

   `src/orchestrator/execution/agent-loop/agent-loop-command-classifier.ts:3` categorizes command results as verification, observation, or other. It uses verification regexes at `src/orchestrator/execution/agent-loop/agent-loop-command-classifier.ts:30` and observation regexes at `src/orchestrator/execution/agent-loop/agent-loop-command-classifier.ts:43`.

   `src/orchestrator/execution/agent-loop/task-agent-loop-verification.ts:4` defines mechanical verification prefixes, `src/orchestrator/execution/agent-loop/task-agent-loop-verification.ts:21` defines verb prefixes, and `src/orchestrator/execution/agent-loop/task-agent-loop-verification.ts:80` extracts verification families from freeform command/method text.

   This affects evidence eligibility and task relevance. It should become typed verification-plan metadata and typed tool-result categories after #1110/#1115 instead of expanding command phrase lists.

5. Chat context gathering uses task-text keyword extraction.

   `src/interface/chat/chat-runner.ts:579` calls `buildChatContext(safeInput, executionCwd)` for native agent-loop grounding, and `src/interface/chat/chat-runner.ts:625` uses it for the non-native adapter prompt. The implementation in `src/platform/observation/context-provider/collector.ts:408` splits the task description into words, filters length, takes the first three, greps matching files, and injects excerpts labeled with the selected keyword.

   `src/platform/observation/context-provider/search-terms.ts:1` maps dimension names to search terms using substring checks like todo/fixme/test/coverage/lint/error/doc. `src/platform/observation/context-provider/shared.ts:16` classifies memory tier from label substrings such as goal/gap/strategy/recent changes/test status/archive.

   This does not execute tools directly, but it is a freeform semantic shortcut in the grounding path. Replace it with a structured query planner, explicit code-search query contract, or typed context item metadata rather than more keyword terms.

6. Runtime health and ownership derive typed state from fallback text substrings.

   `src/runtime/daemon/runner-goal-cycle.ts:75` counts pending approvals from `goal.approval_pending === true` but also falls back to `goal.wait_reason.toLowerCase().includes("approval")`. `src/runtime/daemon/runtime-ownership.ts:267` derives metric direction from `summary.includes("direction=minimize")`.

   Both have a typed destination already. Once producers reliably emit `approval_pending` and metric direction, remove the summary/wait-reason text fallback.

7. Artifact retention cleanup class is partly inferred from labels and paths.

   `src/runtime/store/artifact-retention.ts:193` first checks typed artifact/candidate/evidence data, but then builds a lowercase haystack from artifact label/path/state path at `src/runtime/store/artifact-retention.ts:203`. It marks `smoke`, `cache`, `tmp/`, and `intermediate` substrings as low-value/cache classes at `src/runtime/store/artifact-retention.ts:204`, and those classes become delete candidates at `src/runtime/store/artifact-retention.ts:223`.

   This is not raw user freeform, but it is a semantic cleanup decision from labels/paths. It should move to typed artifact `retention_class`, source, kind, or discovery metadata before destructive cleanup automation expands.

8. Agent-loop failure classification still uses provider/error text.

   `src/orchestrator/execution/agent-loop/bounded-agent-loop-runner.ts:530` converts unknown errors into text and classifies timeout by substring checks at `src/orchestrator/execution/agent-loop/bounded-agent-loop-runner.ts:536`. `src/orchestrator/execution/agent-loop/chat-agent-loop-runner.ts:248` repeats the timeout check, and `src/orchestrator/execution/agent-loop/chat-agent-loop-runner.ts:305` uses `^Calling\s+` on final assistant text when formatting repeated tool-error failures.

   These should become typed deadline/abort/provider error codes and structured response phases. Until then, treat the current text parsing as a compatibility fallback, not a pattern to extend.

## Exact Protocol / Non-findings

- Slash chat commands are exact protocol grammar. `src/interface/chat/chat-runner-commands.ts:108` parses `/resume`, `src/interface/chat/chat-runner-commands.ts:116` dispatches only inputs starting with `/`, and `src/interface/chat/chat-runner-commands.ts:166` parses `--dry-run` as an exact flag. These are allowed deterministic surfaces.
- TUI exact command handling is separated from natural-language classification. `src/interface/tui/intent-recognizer.ts:30` defines command aliases, `src/interface/tui/intent-recognizer.ts:93` checks exact commands first, and `src/interface/tui/intent-recognizer.ts:134` uses a structured LLM schema for natural language.
- Pending RunSpec confirmation is exact command first, structured classifier second. `src/runtime/run-spec/pending-dialogue-arbiter.ts:27` checks exact `/approve`, `/confirm`, `/cancel`, and `/reject`; otherwise it uses `RunSpecPendingDialogueDecisionSchema` and confidence gating.
- RunSpec derivation is a structured schema boundary. `src/runtime/run-spec/derive.ts:77` defines `RunSpecDraftSchema`, `src/runtime/run-spec/derive.ts:150` parses through the model/schema path, and low confidence returns null.
- Runtime-control routing is structured and fail-closed. `src/runtime/control/runtime-control-intent.ts:33` defines the decision schema, `src/runtime/control/runtime-control-intent.ts:94` classifies with an LLM/schema contract, and parse failures return `unclassified`.
- Runtime target selection uses exact IDs and typed selectors, not title matching. `src/runtime/control/runtime-target-resolver.ts:41` resolves explicit run/session IDs against the runtime catalog, `src/runtime/control/runtime-target-resolver.ts:62` handles typed selector references, and `src/runtime/control/runtime-target-resolver.ts:99` rejects stale/terminal targets.
- Runtime evidence Q&A is structured. `src/runtime/evidence-answer.ts:60` defines a topic schema, `src/runtime/evidence-answer.ts:80` forbids natural-language labels in `targetRunId`, and `src/runtime/evidence-answer.ts:262` treats exact run IDs as deterministic protocol. Topic membership checks at `src/runtime/evidence-answer.ts:224` operate on schema enums.
- Notification routing uses schema parsing, not keyword tables. `src/runtime/notification-routing.ts:45` defines `NotificationRoutingDecisionSchema`, `src/runtime/notification-routing.ts:182` parses through that schema, and unsupported/ambiguous outcomes are typed.
- Gateway/channel allow/deny policy is based on channel, sender, conversation, and config IDs. Cross-platform chat dispatch itself is not just transport policy: `src/interface/chat/cross-platform-session.ts:798` mirrors the structured freeform/runtime-control/RunSpec route derivation path before calling the typed ingress router. The audit did not find a production message-text keyword path there.
- Markdown rendering, syntax highlighting, style labels, CLI option parsing, file path checks, URL parsing, schema enum validation, plugin name/version validation, and exact mention/user-input item types are non-findings unless they feed a freeform routing/safety/status decision.

## Uncertain

- `src/interface/chat/failure-recovery.ts` primarily prefers structured evidence and typed stop reasons, but it also accepts string-like `code`, `reason`, and `stoppedReason` fields from callers. The audit did not prove every producer avoids stuffing provider prose into those fields. Treat any raw error-string fallback there as Uncertain until producer contracts are verified.
- TUI command suggestions and fuzzy command display helpers are likely harmless because they only suggest UI affordances, not execute actions. Keep them out of purge scope unless #1119 makes suggestions part of executable protocol selection.
- Session/artifact filename helpers that infer categories from paths such as logs, metrics, results, or evidence look deterministic and file-oriented. They are lower priority than runtime cleanup decisions, but should be revisited before automatic deletion or operator-critical routing depends on them.
- Language detection and localized response formatting look presentation-only in the inspected paths. They should not become routing/permission classifiers.

## Recommended Purge Order After #1110-#1119

1. Replace command-result and tool-activity classification with structured tool metadata.

   Depend on #1110's `ResponseItem`/ToolRouter contract and #1115-style observation typing. Update `agent-loop-command-classifier`, `task-agent-loop-verification`, `chat-event-state`, and `agent-timeline` so tool execution, observation eligibility, and activity labels come from typed tool calls/results rather than command/tool-name substrings.

2. Consolidate shell safety and approval policy.

   Keep `!` and shell command syntax as exact protocol, but move safety/capability classification behind the same typed tool execution boundary. Ensure TUI direct shell execution cannot bypass approval policy by using a trusted/preapproved context too early.

3. Replace chat context keyword grep with typed context planning.

   Remove task-description word extraction from `collectChatContextParts`. Use a structured query planner, code-search tool call, or explicit context-query contract that can return unknown/no-op instead of relying on the first three long words.

4. Remove text fallbacks when typed fields exist.

   Drop `wait_reason.includes("approval")` once `approval_pending` is always produced. Replace `summary.includes("direction=minimize")` with a typed metric direction field.

5. Type artifact retention metadata before cleanup expands.

   Require `retention_class`, artifact kind, source, or discovery metadata from producers. Keep destructive cleanup approval-gated and avoid label/path substring classification as the primary retention decision.

6. Replace error-text fallback with typed failure reasons.

   Use typed timeout/deadline/abort/provider errors and structured response phases. Keep raw-text fallbacks only at display boundaries while migration is incomplete.

## Test Requirements

- For every freeform semantic replacement, include at least one production caller-path test where the real routing/interpretation layer receives user-like input and chooses the path.
- Add stale/previous-target rejection tests for runtime-control and evidence target selection whenever selector behavior is touched.
- Add multilingual/paraphrase tests only for structured freeform classifiers, and make sure they would fail a brittle keyword/phrase-list implementation.
- For shell execution, test exact `!` grammar separately from typed safety policy. Include safe read-only, write, network, destructive, protected-path, and approval-denied cases through the actual TUI/chat/tool boundary, including the direct `resolveTuiInputAction` -> `ShellTool.call` route.
- For ToolRouter/ResponseItem follow-up work, test model text, valid tool call, invalid tool args, unknown tool, tool result, and tool error as structured items. Do not route tools by re-reading the original user sentence.
- For context gathering replacement, test that arbitrary freeform paraphrases do not become grep terms unless a structured query contract explicitly requests them.
- For artifact retention and runtime health, test typed producers and consumers together. A test that directly passes a precomputed lower-level category is not sufficient for this audit area.

## Open Questions

- Should shell command policy be handled by a real command parser per shell, a conservative host capability API, or a hybrid where unknown command text always requires approval?
- What is the canonical typed source for tool `activityCategory`: tool registry metadata, each `ToolResult`, or the `ResponseItem` stream?
- Should chat grounding be driven by a dedicated `code_search` tool call after #1110, or should the host still pre-build a context bundle from a typed query planner?
- Which producer should own artifact `retention_class` for runtime outputs: tool result metadata, evidence ledger entries, or artifact manifest discovery?
- After #1110-#1119 merge, should #1120 be split into smaller purge issues by subsystem before implementation starts?
