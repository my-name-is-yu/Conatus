# SeedPulse Codex Rules

## Test Design

- Regression tests must exercise the same entrypoint shape and key input flags used in production. A fixture name or reused fake object is not enough.
- When a bug crosses a boundary between coordinator and runner, keep the narrow mock test, but add at least one contract test that runs the real downstream component that interprets the payload.
- For stateful chat, runtime, gateway, and TUI paths, cover at least two turns when the behavior depends on session state, route state, reply targets, persisted state paths, or resume semantics.
- Tests that claim "resume", "reuse", "latest", "current", "active", or "selected" must assert both the positive path and the stale/previous-turn value that must not be used.
- If a fix changes the meaning of an input field, add a test that would fail on the old implementation because that exact field is present.
- A test suite named or treated as integration must cross at least one real production boundary. If all downstream collaborators are `vi.fn()` fixtures, label it as mock/delegation coverage and add a separate contract test for the real seam.
- Route, gateway, runtime-control, and CoreLoop tests must include at least one caller-path test that lets production routing/interpretation choose the path; do not only pass precomputed route or policy objects into the lower-level method.
- If a test only passes in isolation but times out or flakes in the full lane, fix the lane classification, timeout, or shared-state isolation before trusting the result.
- Changes under `plugins/*` or `examples/plugins/*` must run subpackage verification in addition to root Vitest related tests when package manifests, configs, or package-local sources change.
