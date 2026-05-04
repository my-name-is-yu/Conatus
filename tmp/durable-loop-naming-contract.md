# DurableLoop Naming Contract

## Responsibility Boundaries

`ChatRunner` owns conversation and turn orchestration. It interprets a chat turn, coordinates approvals and replies, and may hand durable work to the runtime, but it is not the long-running execution loop itself.

`AgentLoop` owns bounded interactive and tool-using agent execution. It can gather evidence, run focused planning or repair phases, and return control to its caller. It should remain scoped to a bounded phase rather than becoming the daemon-backed lifecycle owner.

`DurableLoop` is the official name for daemon-backed resilient long-running execution. It owns durable goal progress over time, restartable background work, long-running iteration state, and runtime/session integration for work that survives beyond a single chat turn or bounded agent phase.

## Compatibility Surfaces

The legacy `CoreLoop`, `core-loop`, and `coreloop` names may remain temporarily where they are observable compatibility surfaces or old import paths:

- Deprecated TypeScript exports such as `CoreLoop`, `CoreLoopDeps`, and `createCoreLoop...` helpers while callers migrate to `DurableLoop` names.
- Compatibility re-export shims for old module paths such as `src/orchestrator/loop/core-loop.ts` and `src/orchestrator/loop/core-loop/`.
- Persisted storage and wire identifiers already written by released code, including `run:coreloop:*`, `coreloop_run`, `coreloop` session/tool filters, event scopes, and log filenames.
- Historical changelog or architecture notes that intentionally describe pre-migration behavior.
- Tests that explicitly verify legacy compatibility.

New primary implementation code and current-facing docs should use `DurableLoop` once the relevant migration issue reaches that surface.

## Persisted And User-Facing Names

Persisted run IDs, event kinds, session kinds, and runtime ledger data must not be broken by a string replacement. Existing `run:coreloop:*`, `coreloop_run`, and `coreloop` records must remain readable throughout the migration. If a later issue introduces new durable names for persisted data, it must add explicit compatibility reads for the legacy names and tests that load old data.

CLI, chat, TUI, and docs should move to the current-facing `DurableLoop` label in #1018 and #1019, while preserving legacy IDs in output where the ID itself is the stable handle. User-facing status text should describe the mechanism as DurableLoop; stable identifiers may still contain `coreloop` until a compatibility-safe storage migration exists.

## Migration Order

1. #1015 defines this naming contract and compatibility policy without broad implementation rename.
2. #1016 adds `DurableLoop` aliases and helpers while preserving existing `CoreLoop` callers and source locations.
3. #1017 moves the primary internal modules to `durable-loop` paths and leaves `core-loop` compatibility shims.
4. #1018 updates runtime, session, CLI, chat, and TUI labels to DurableLoop while keeping legacy persisted data readable.
5. #1019 updates current-facing docs and removes obsolete aliases or documents why remaining legacy names are still required.

## Current Inventory Summary

The pre-migration inventory found `CoreLoop`, `core-loop`, and `coreloop` references in current docs, architecture docs, CLI/TUI/chat interfaces, runtime session tools, orchestrator loop implementation files, persisted runtime test fixtures, and e2e/unit tests. That inventory confirms the migration must be staged: aliases before file moves, file moves before user-facing label changes, and documentation cleanup after runtime compatibility is verified.
