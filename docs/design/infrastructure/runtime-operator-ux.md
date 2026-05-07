# Runtime Operator UX And Background Task Controls

Status: design proposal for #1190.

This document defines the operator-facing experience for observing and
controlling background work across chat, TUI, CLI, daemon snapshots, runtime
sessions, and future GUI surfaces. It assumes #1189 has already defined the
lower-level auth handoff, browser session, and guardrail runtime model.

## Goals

- Make background runs and sessions visible through one typed runtime catalog.
- Track detached background work as an activity ledger, separate from sessions,
  schedulers, and heartbeat turns.
- Route chat, TUI, CLI, and daemon control through shared runtime-control APIs
  instead of surface-local text matching or duplicated command logic.
- Preserve stale/current/selected target semantics across at least two turns.
- Deliver completion, failure, and intervention state through typed notification
  policy instead of relying on polling loops.
- Represent file-change and diff visibility as runtime artifacts/events that
  can be rendered differently by each surface without changing the underlying
  contract.
- Decide which controls are implementation-ready now and which belong to later
  UX exploration.

## External Reference: OpenClaw

OpenClaw is a useful reference for #1190 because it is closer to PulSeed's
resident, multi-channel runtime shape than most coding-only agents.

Relevant public docs:

- [OpenClaw Background Tasks](https://docs.openclaw.ai/automation/tasks)
  separates tasks from sessions, cron, and heartbeat. Tasks are records of
  detached work, not schedulers.
- [OpenClaw Session Tools](https://docs.openclaw.ai/concepts/session-tool)
  distinguishes read visibility, cross-session messaging, spawned subagents,
  and scoped session access.
- [OpenClaw ACP Agents](https://docs.openclaw.ai/tools/acp-agents) defines
  explicit session binding, steering, cancellation, and unsupported-control
  errors for external harness sessions.
- [OpenClaw Presence](https://docs.openclaw.ai/concepts/presence) keeps
  gateway/client presence as an ephemeral operator view rather than the source
  of task truth.

PulSeed should adopt the durable parts of that model: task records,
push-oriented completion, notification policy, scoped session visibility,
runtime-aware audit, and explicit target binding. PulSeed should not copy the
slash-command-first UX as the primary surface; natural-language routing must
still resolve into typed runtime contracts.

## Current Production Caller Paths

The current implementation already has several production paths that should be
extended rather than bypassed.

### Runtime Catalog

- `src/runtime/session-registry/registry.ts` builds the runtime session and
  background-run snapshot from chat history, agent-loop state, task ledgers,
  daemon snapshots, supervisor state, evidence ledgers, and process sidecars.
- `src/runtime/session-registry/types.ts` defines the durable catalog surface:
  `RuntimeSession`, `BackgroundRun`, artifact refs, reply targets, source refs,
  and warnings.
- `src/tools/query/runtime-session-tools.ts` exposes model-facing read-only
  tools such as `sessions_list`, `sessions_read`, session history, children,
  run observation, and completion/status summaries.
- `src/interface/cli/commands/runtime.ts` exposes read-only CLI inspection for
  sessions, runs, evidence, budgets, experiment queues, postmortems, and related
  runtime records.

### Runtime Control

- `src/runtime/control/runtime-control-intent.ts` classifies freeform operator
  requests into typed runtime-control intents. This is the only appropriate
  primary decision path for natural-language run/session control.
- `src/interface/chat/ingress-router.ts` and
  `src/interface/chat/chat-runner-routes.ts` route recognized runtime-control
  requests into `RuntimeControlService`.
- `src/runtime/control/runtime-control-service.ts` records operations, gates
  approvals, resolves targets, rejects stale/ambiguous selections, appends
  evidence, and dispatches executable operations.
- `src/runtime/control/runtime-target-resolver.ts` resolves explicit, current,
  latest, previous, and mentioned targets from the runtime catalog and rejects
  terminal/stale selections for mutating controls.
- `src/runtime/control/daemon-runtime-control-executor.ts`,
  `src/runtime/event/server-command-handler.ts`, and
  `src/runtime/daemon/runner-commands.ts` form the daemon-side execution path.
- `src/tools/runtime/SetupRuntimeControlTools.ts` exposes model-visible
  runtime status and run pause/resume/cancel tools, including an observed run
  epoch guard before mutating state.

### Chat And TUI Surfaces

- `src/interface/tui/entry-deps.ts` wires `RuntimeControlService` into both
  local-mode and daemon-mode TUI chat surfaces.
- `src/interface/tui/chat-surface.ts` and
  `src/interface/chat/cross-platform-session.ts` provide the shared chat
  execution surface used by TUI and gateway entrypoints.
- `src/interface/chat/chat-events.ts` defines the current typed event stream:
  lifecycle, assistant deltas/final, activity, tool lifecycle, agent timeline,
  operation progress, and lifecycle errors.
- `src/interface/chat/chat-runner-support.ts` captures git diff artifacts and
  emits `activity` events with `kind: "diff"` after coding turns.
- `src/interface/tui/diff-view.tsx`, `src/interface/tui/report-view.tsx`, and
  `src/interface/tui/chat.tsx` are the current TUI render targets for
  conversation output and diff/report views.

## Current Gaps

### Observation Is Split Between Catalogs, Tools, And Surfaces

Runtime sessions, background runs, process sessions, and daemon state are
projected into one catalog, but not every surface consumes the same detail
level. CLI has useful table/detail output. Model tools expose structured data.
TUI chat can route control requests, but it does not yet have a first-class
operator panel for runs, notifications, artifacts, and stale selections.

### Detached Work Needs A Task Ledger

The runtime currently projects background runs, but operator UX also needs the
activity-ledger concept: detached work that happened outside the main
conversation, why it exists, who requested it, where completion should be
delivered, and whether it still has authoritative backing state. This should be
separate from scheduling. Cron and heartbeat decide when work starts; a task
record tracks what happened and what the operator can do about it.

### Control Coverage Is Smaller Than The Desired UX

The implementation-ready controls are `list`, `show/inspect`,
`pause_run`, `resume_run`, `cancel_run`, and `finalize_run` proposals. Desired
operator nouns such as audit, notification policy, history, and diff/status
presentation mostly exist as read models or artifacts, not as coherent controls.

OpenClaw's small notification vocabulary is a useful target for the first
PulSeed contract: `silent`, `done_only`, and `state_changes`. PulSeed already
has a nearby `BackgroundRun.notify_policy` shape, so setting notification policy
is implementation-ready once routed through `RuntimeControlService` with stale
target checks.

### Resume Semantics Exist, But Are Not Yet One Contract

Chat `/resume` supports saved agent-loop state and maps runtime conversation
and agent IDs back to owning chat sessions. Runtime target resolution handles
current/latest/previous run selectors and rejects stale targets for run control.
These are related but not yet documented as one cross-surface rule set for
"current", "selected", "latest", "previous", and exact IDs.

### Diff Visibility Is Chat-Centric

Diffs are currently emitted as chat activity events and as artifact refs for
process sessions. The runtime catalog can carry `RuntimeArtifactRef.kind:
"diff"`, but there is no normalized "file change summary" event that lets TUI,
CLI, daemon snapshots, and future GUI surfaces render the same change state.

### Progress Narration Has Multiple Sources

There are typed `operation_progress`, `agent_timeline`, tool lifecycle, and
activity events. CoreLoop-style narration should not be generated as freeform
surface text when a production event can describe the same state. The design
should prefer typed event streams first, with model text reserved for semantic
summaries after the underlying event has a durable source.

### Presence Is Useful But Ephemeral

A future daemon/TUI presence view can show connected gateways, clients, nodes,
and recent operator activity. It must remain separate from runtime task truth.
Presence entries should be TTL-bound and best-effort; sessions, runs, tasks, and
operation records remain the authoritative state for controls and audit.

## Target Operator Model

Use five related but separate concepts.

```ts
type RuntimeNotificationPolicy = "silent" | "done_only" | "state_changes";

type RuntimeOperatorSelection = {
  kind: "run" | "session";
  id: string;
  selected_at: string;
  observed_epoch: string;
  source: "exact_id" | "current" | "latest" | "previous" | "mentioned" | "ui_selection";
  conversation_id?: string | null;
  surface: "chat" | "tui" | "cli" | "gateway" | "gui";
};

type RuntimeOperatorControl =
  | "inspect_run"
  | "pause_run"
  | "resume_run"
  | "cancel_run"
  | "finalize_run"
  | "audit_runtime_tasks"
  | "set_notification_policy"
  | "record_audit_note";

type RuntimeOperatorTask = {
  task_id: string;
  runtime: "agent" | "coreloop" | "process" | "subagent" | "cron" | "cli" | "external";
  status: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "lost" | "unknown";
  requester_session_id?: string | null;
  child_session_id?: string | null;
  run_id?: string | null;
  notify_policy: RuntimeNotificationPolicy;
  delivery: {
    mode: "direct" | "session_queued" | "silent" | "unknown";
    reply_target?: RuntimeReplyTarget | null;
    last_error?: string | null;
  };
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
  cleanup_after?: string | null;
  summary?: string | null;
  error?: string | null;
  source_refs: RuntimeSessionRef[];
};

type RuntimeOperatorPresentation = {
  run_id?: string;
  session_id?: string;
  task_id?: string;
  status: string;
  summary?: string | null;
  attention?: "none" | "blocked" | "failed" | "lost" | "needs_approval";
  notify_policy?: RuntimeNotificationPolicy;
  artifacts: Array<{ kind: "log" | "metrics" | "report" | "diff" | "url" | "other"; label: string; ref: string }>;
  progress: Array<{ kind: string; label: string; observed_at: string; ref?: string }>;
  changes?: {
    files_changed: number;
    insertions?: number;
    deletions?: number;
    patch_ref?: string | null;
    summary?: string | null;
  };
};

type RuntimePresenceEntry = {
  instance_id: string;
  mode: "gateway" | "tui" | "cli" | "web" | "node" | "probe" | "unknown";
  status: "active" | "idle" | "stale";
  observed_at: string;
  expires_at: string;
  metadata?: Record<string, unknown>;
};
```

`RuntimeOperatorSelection` is host-only state. It may guide the next turn, but a
mutating control must re-resolve the target against the current runtime catalog
and compare `observed_epoch` or equivalent freshness evidence before dispatch.

`RuntimeOperatorTask` is a durable activity ledger record. It does not schedule
work and it does not replace `RuntimeSession` or `BackgroundRun`. It exists so
operator surfaces can answer: what detached work is active, what owns it, where
completion should go, and whether the backing runtime state is still credible.

`RuntimeOperatorControl` is the durable control vocabulary. Chat and TUI should
not invent additional surface-only operations. If a surface needs a new control,
add it to the runtime-control schema first, then implement the surface affordance.

`RuntimeOperatorPresentation` is a read model. It can be rendered as CLI text,
TUI rows, chat prose, or GUI widgets without changing target resolution or
control execution.

`RuntimePresenceEntry` is a best-effort daemon/client view for operator
orientation. It must never be used as the source of truth for mutating controls.

## Selection And Resume Semantics

All surfaces should use these rules:

- Exact run/session IDs are allowed only if the catalog still contains the
  target and the operation permits its current status.
- `current` and `mentioned` are scoped to the originating conversation when a
  conversation ID is available. If more than one candidate remains, ask for a
  specific ID.
- `latest` is an explicit operator choice, not an implicit fallback after an
  exact or selected target fails.
- `previous` requires at least two eligible candidates and must never mean "the
  stale selected run from the last turn".
- A UI-selected target must carry an observed epoch. Mutating controls must
  reject the operation if the run has changed since selection unless the user
  re-confirms against the fresh state.
- `/resume` of chat/agent-loop state and `resume_run` of a background run are
  different operations. Natural-language routing must preserve that distinction
  through typed intent classification and target resolution.
- Bound conversation/thread targets should resolve before requester-session
  fallbacks, and failure to resolve a bound target should return a clear typed
  error rather than silently selecting the latest run.

## Implementation-Ready Controls

These controls can be implemented with the current architecture.

### List And Show

Source of truth: `RuntimeSessionRegistry.snapshot()` plus the task/activity
ledger projection.

Surfaces:

- CLI: extend `pulseed runtime sessions|runs` detail output if needed.
- Chat/model: continue using `sessions_list`, `sessions_read`, and run
  observation tools.
- TUI: add a runtime panel/list backed by the same snapshot and display warning
  count, status, updated time, workspace, title, artifacts, task pressure,
  notify policy, and reply target.

Required tests:

- Registry contract test that includes conversation, agent, coreloop, process,
  artifact, warning, and reply-target records.
- Task projection test that distinguishes sessions, background runs, scheduled
  entries, heartbeat turns, and detached task records.
- TUI caller-path test that loads the real registry snapshot projection rather
  than passing precomputed rows only.

### Inspect

Source of truth: `RuntimeControlService.inspectRun()` and
`RuntimeSessionRegistry.snapshot()`.

Behavior:

- Read-only, no approval required.
- Reject unknown exact IDs.
- For `current` or `mentioned`, ask for clarification when multiple candidates
  match.
- Include source refs, artifacts, warnings, status, updated epoch, and summary.

Required tests:

- Chat production route test from freeform inspection request through typed
  runtime-control classification into `RuntimeControlService`.
- CLI inspection test using the real registry snapshot shape.

### Pause, Resume, Cancel

Source of truth: `RuntimeControlService` plus daemon executor.

Behavior:

- Approval required.
- Target must be active for pause/cancel.
- Resume may target active or attention-needed runs, but must still require a
  typed runtime bridge.
- Exact stale IDs must fail closed. They must not fall back to latest.
- Surface selected targets must include observed epoch and reject changed state.

Required tests:

- Two-turn chat test: user selects a current run, another run becomes latest,
  then the second turn controls the selected run only if the observed epoch is
  still valid.
- Stale selected-session rejection test: selected run becomes terminal before
  approval; control is blocked and no daemon command is sent.
- Daemon caller-path test crossing
  `RuntimeControlService -> daemon-runtime-control-executor -> event command
  handler` with the real command payload.

### Finalize

Source of truth: `RuntimeControlService.finalizeRun()` and
`RuntimeOperatorHandoffStore`.

Behavior:

- Approval required.
- Records a finalization handoff/proposal.
- Does not execute external submit, publish, secret, production mutation, or
  destructive cleanup.
- Presents external action risk as typed metadata, not as prose-only warning.

Required tests:

- Contract test proving denied approval preserves a typed non-execution state.
- Test proving external actions are recorded as proposal metadata and no
  external tool is called.

### Notification Policy

Source of truth: `RuntimeControlService` plus the task/run notification policy
field.

Behavior:

- Accept only `silent`, `done_only`, and `state_changes`.
- The policy controls operator delivery volume; it must not change whether the
  underlying task/run is recorded.
- `state_changes` may emit progress or transition notifications, but must still
  reference typed task/run state.
- `silent` suppresses operator notification, not audit, task recording, or
  failure visibility in explicit status/audit views.

Required tests:

- Chat production route test that changes notification policy through typed
  runtime-control intent and rejects stale selected targets.
- Task/run projection test proving silent tasks are hidden from push delivery
  but remain visible in explicit list/audit views.

### Task Audit And Maintenance Preview

Source of truth: the task/activity ledger, runtime session registry, and
evidence ledger.

Behavior:

- Read-only audit is implementation-ready: surface warnings for stale queued
  work, stale running work, lost runtime backing, delivery failure, missing
  cleanup timestamp, inconsistent timestamps, and terminal failures.
- Maintenance apply is a separate mutating control and should not ship in the
  first audit issue.
- Audit findings should flow into CLI/TUI/status views as structured warnings,
  not only prose.

Required tests:

- Audit projection test for at least `stale_queued`, `stale_running`, `lost`,
  `delivery_failed`, and `inconsistent_timestamps`.
- Caller-path test that verifies `/status` or TUI runtime status consumes the
  same audit projection as CLI, instead of re-implementing local checks.

## Not Yet Implementation-Ready

These should remain design or follow-up work until their typed contracts are
defined.

- Arbitrary "audit note" commands that write freeform operator notes. First
  define an append-only runtime audit entry schema and its relationship to
  evidence ledger entries.
- Rich notification routing beyond `silent`, `done_only`, and `state_changes`.
  First define whether per-channel overrides live on task records, owning chat
  session metadata, operator handoff records, or a separate policy store.
- Rich diff/status presentation in TUI or GUI. First normalize file-change
  summary artifacts so surfaces do not parse chat prose.
- CoreLoop-style narration as a UX stream. First map the existing
  `operation_progress`, `agent_timeline`, tool lifecycle, and daemon events to
  a durable progress projection.
- Bulk operations over multiple runs. First add explicit multi-target schema,
  preview, approval, and partial-failure semantics.

## Task Ledger And Push Delivery

Background work should use a push-oriented completion model:

- Starting detached work creates or links a `RuntimeOperatorTask`.
- Normal interactive chat and heartbeat turns do not create task records unless
  they spawn detached work.
- Terminal state triggers delivery based on `notify_policy`.
- If direct delivery has a reply target, the runtime sends the completion there.
- If direct delivery is unavailable, completion is queued into the requester
  session and can wake the runtime/heartbeat so the operator sees the result.
- Polling task state is for debugging, intervention, and audit, not the primary
  completion path.

Task records must retain enough source refs to reconcile whether active work is
still real. A task can become `lost` only after the runtime-specific owner has
disappeared or become unverifiable for a bounded grace period. Cleanup failures
must not mask the real terminal outcome.

## File Change And Diff Visibility

Diff visibility should be represented in the runtime layer as structured
artifact metadata, with raw patches remaining in files or artifact refs.

Proposed extension:

```ts
type RuntimeChangeSummary = {
  schema_version: "runtime-change-summary-v1";
  run_id: string;
  workspace: string;
  observed_at: string;
  files: Array<{
    path: string;
    status: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "unknown";
    insertions?: number;
    deletions?: number;
  }>;
  patch_ref?: RuntimeArtifactRef | null;
  source_ref: RuntimeSessionRef;
};
```

Chat may continue to emit a concise `activity` event with `kind: "diff"`, but
that event should point at a `RuntimeChangeSummary` or patch artifact when the
change belongs to a background run. TUI and CLI should render the summary from
structured data, not from the chat message body.

## Progress And Narration

The primary progress contract should be typed event data:

- `tool_start`, `tool_update`, and `tool_end` for tool execution.
- `agent_timeline` for agent-loop steps.
- `operation_progress` for high-level route or task progress.
- daemon/runtime events for background worker lifecycle and control execution.

Model-generated narration may summarize these events, but it should not be the
only durable record of state. If CoreLoop-style narration is added, implement it
as a projection over production events with a stable event kind and source ref.

## Follow-Up Coding Issues

### 1. Runtime Operator Read Model

Implement `RuntimeOperatorPresentation` as a projection over
`RuntimeSessionRegistrySnapshot` and the task/activity ledger.

Acceptance:

- Covers sessions, runs, tasks, artifacts, warnings, reply targets, notification
  policy, and update epochs.
- Used by at least one CLI command and one TUI/chat caller path.
- Includes a caller-path test using the real registry snapshot projection.

### 2. Runtime Task Ledger And Push Completion

Add a task/activity ledger for detached background work and connect terminal
state to typed completion delivery.

Acceptance:

- Creates task records for daemon/agent detached work, process-backed work,
  scheduled executions, and future subagent/external harness work.
- Does not create task records for ordinary chat or heartbeat-only turns.
- Supports `silent`, `done_only`, and `state_changes`.
- Completion can be delivered directly or queued to the requester session.
- Reconciliation can mark unverifiable active tasks as `lost` after a bounded
  grace period.

### 3. TUI Runtime Panel For Sessions, Runs, And Tasks

Add a TUI runtime panel that lists active and attention-needed sessions/runs and
tasks, shows detail for the selected target, and stores host-only selection with
an observed epoch.

Acceptance:

- Displays active, failed/timed-out/lost, task pressure, notification policy,
  and warning states.
- Selection does not mutate runtime state.
- Mutating follow-up actions must pass the selected ID and observed epoch to the
  runtime-control path.
- Test covers stale selected target rejection after a two-turn/state change.

### 4. Epoch-Guarded Run Controls Across Chat And Tools

Extend runtime-control requests or tool inputs so chat/TUI selected targets can
carry an observed run epoch, then reject changed targets before daemon dispatch.

Acceptance:

- Exact ID, current, latest, previous, and UI-selected target paths are covered.
- Exact stale target never falls back to latest.
- At least one test crosses the real chat route into `RuntimeControlService`.
- At least one test crosses the real daemon executor boundary.

### 5. Runtime Task Audit And Notification Policy

Add read-only task audit and a narrow notification-policy control.

Acceptance:

- Audit reports stale queued/running work, lost backing state, delivery failure,
  missing cleanup timestamp, inconsistent timestamps, and terminal failures.
- Audit findings appear in CLI and at least one runtime status/TUI caller path.
- Notification policy accepts only `silent`, `done_only`, and `state_changes`.
- Silent tasks remain visible in explicit audit/list views.
- Notification-policy mutation goes through `RuntimeControlService` and rejects
  stale selected targets.

### 6. Runtime Change Summary Artifact

Add a structured change-summary artifact for background runs and teach chat/TUI
rendering to consume it.

Acceptance:

- Captures changed files and patch refs without requiring prose parsing.
- Existing chat `diff` activity remains available for display.
- TUI/CLI render from structured data.
- Tests include added, modified, deleted, and untracked files.

### 7. Runtime Audit Notes And Rich Notification Design

Keep this as a design issue before implementation.

Acceptance:

- Defines operator audit-note schema, append-only storage, and evidence-ledger
  relationship.
- Defines rich notification routing beyond the first `silent`, `done_only`, and
  `state_changes` policy.
- Separates operator-visible labels from routing/control decisions.

## Design Decision

Implement #1190 by first building the shared read model and epoch-guarded
control path, then adding the task ledger, notification policy, and TUI
presentation. Do not start with speculative GUI or surface-local controls. The
durable boundary should be:

1. `RuntimeSessionRegistrySnapshot` for observation.
2. Task/activity ledger records for detached work and push completion.
3. `RuntimeOperatorPresentation` for surface-neutral display.
4. `RuntimeControlIntent` and `RuntimeControlService` for natural-language and
   explicit controls.
5. daemon command execution for lifecycle mutations.
6. structured artifacts/events for diff and progress visibility.
7. TTL-bound presence for operator orientation only.

This keeps chat, TUI, CLI, daemon snapshots, and future GUI surfaces aligned
without introducing keyword routing, title matching, or prose-only state.
