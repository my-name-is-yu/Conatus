# Test Fix Research

_Generated: 2026-03-14_

---

## 1. `tests/helpers/` Directory

**Confirmed: Does not exist.** No shared test utility directory. Every test file defines its own local `createMockLLMClient` / `makeMockLLMClient` function inline.

---

## 2. MockLLMClient Implementations — All Locations and Key Differences

### 2a. `src/llm-client.ts` — `MockLLMClient` class (the canonical one)

- **Exported class**: `export class MockLLMClient implements ILLMClient`
- Has `callCount` getter (instance property)
- `parseJSON` delegates to the **real `extractJSON`** helper (handles `\`\`\`json`, generic `\`\`\``, and bare JSON)
- Throws meaningful error when responses exhausted: `MockLLMClient: no response at index N (only M responses configured)`

### 2b. `tests/adapter-layer.test.ts`

- Imports and uses the canonical `MockLLMClient` from `src/llm-client.js` directly — **no local mock**
- Only test file that uses the exported class

### 2c. `tests/ethics-gate.test.ts` — `createMockLLMClient(responses: string[])`

- **Local function**, NOT a class
- No `callCount`
- `parseJSON`: handles `\`\`\`json\n?…\`\`\`` (regex: `/```json\n?([\s\S]*?)\n?```/`) OR falls back to raw content
- Does **not** handle generic `` ``` `` blocks (only `\`\`\`json`)
- Difference from canonical: simpler regex, no generic block fallback

### 2d. `tests/goal-negotiator.test.ts` — `createMockLLMClient(responses: string[])`

- Has `callCount` getter
- `parseJSON`: two-step regex — tries `\`\`\`json\s*…\`\`\`` first, then generic `\`\`\`…\`\`\`` — **matches canonical behavior**
- Throws on out-of-bounds (returns `""` instead — `responses[callIndex++] ?? ""`)
- No explicit out-of-bounds error

### 2e. `tests/strategy-manager.test.ts` — `createMockLLMClient(responses: string[])`

- No `callCount`
- `parseJSON`: same simple regex as ethics-gate (`/```json\n?([\s\S]*?)\n?```/`), bare fallback
- Out-of-bounds returns `""` silently

### 2f. `tests/task-lifecycle.test.ts` — two `createMockLLMClient` variants

- First (main): has `callCount`, two-step regex (```json then generic ```) — matches canonical
- Second (secondary, defined separately for specific test group): no `callCount`, same regex pattern
- Out-of-bounds returns `""` silently for secondary; main also returns `""` silently

### 2g. `tests/capability-detector.test.ts` — `createMockLLMClient(responses: string[])`

- Has `callCount` getter
- `parseJSON`: two-step regex (```json then generic ```) — matches canonical
- Out-of-bounds returns `""` silently

### 2h. `tests/knowledge-manager.test.ts` — `makeMockLLMClient(responses: string[])`

- No `callCount`
- `parseJSON`: two-step regex (```json then generic ```) — matches canonical
- Out-of-bounds **throws** with message `MockLLMClient: no response at index N (M responses configured)` — matches canonical error message style

### 2i. `tests/memory-lifecycle.test.ts` — `makeMockLLMClient(responses: string[])`

- No `callCount`
- `parseJSON`: two-step regex (```json then generic ```) — matches canonical
- Out-of-bounds **throws** with same message format as knowledge-manager — matches canonical

### 2j. `tests/cli-runner.test.ts`

- No local `MockLLMClient` defined; uses `vi.mock("../src/llm-client.js", () => ({ LLMClient: vi.fn()..., MockLLMClient: vi.fn() }))` — vi module mock only

### 2k. `tests/tui/intent-recognizer.test.ts` — `makeMockLLMClient(response: string)`

- Single response string (not array) — different signature from all others
- `parseJSON`: `schema.parse(JSON.parse(content.trim()))` — **NO markdown block handling** — bare JSON only
- No `callCount`

**Summary table:**

| File | callCount | Handles ````json` | Handles generic ```` ``` ```` | Throws on OOB |
|------|-----------|-------------------|-------------------------------|---------------|
| `src/llm-client.ts` (canonical) | YES | YES | YES | YES |
| `tests/adapter-layer.test.ts` | YES (uses canonical) | YES | YES | YES |
| `tests/ethics-gate.test.ts` | NO | YES | NO | NO (silent `""`) |
| `tests/goal-negotiator.test.ts` | YES | YES | YES | NO (silent `""`) |
| `tests/strategy-manager.test.ts` | NO | YES | NO | NO (silent `""`) |
| `tests/task-lifecycle.test.ts` | YES (main) | YES | YES | NO (silent `""`) |
| `tests/capability-detector.test.ts` | YES | YES | YES | NO (silent `""`) |
| `tests/knowledge-manager.test.ts` | NO | YES | YES | YES |
| `tests/memory-lifecycle.test.ts` | NO | YES | YES | YES |
| `tests/tui/intent-recognizer.test.ts` | NO | NO | NO | N/A (single response) |

---

## 3. `isPermanentlyGated` vs `hasPermanentGate` — Real Method Name

**Confirmed:**

- `src/trust-manager.ts` line 234: **`hasPermanentGate(domain: string, category: string): boolean`** — this is the real public method name
- Line 166: internal call site: `this.hasPermanentGate(domain, category)`

- `tests/tui/use-loop.test.ts` line 76: mock uses **`isPermanentlyGated`** — **this is WRONG**
  - The mock is: `isPermanentlyGated: vi.fn().mockReturnValue(false)`
  - `makeMockTrustManager` at line 68-78 uses `isPermanentlyGated` but the real method is `hasPermanentGate`

**Discrepancy:** Test mock uses a non-existent method name. The mock object is cast `as unknown as TrustManager` so TypeScript does not catch this. If `LoopController` internally calls `trustManager.hasPermanentGate(...)`, the mock will silently return `undefined` (not `false`) in tests.

---

## 4. `report_type: "daily"` in `tests/actions.test.ts` vs Real Type Union

**Confirmed bug:**

- `tests/actions.test.ts` line 60: `report_type: "daily" as const`
- `src/types/core.ts` lines 212-222: `ReportTypeEnum` is:
  ```
  "daily_summary" | "weekly_report" | "urgent_alert" | "approval_request" |
  "stall_escalation" | "goal_completion" | "strategy_change" |
  "capability_escalation" | "execution_summary"
  ```
- **`"daily"` does not exist** in the enum. The correct value is **`"daily_summary"`**.
- The fixture at line 57-68 uses `"daily" as const` which bypasses Zod validation since it's a raw object literal with `as const`.
- If `ActionHandler` passes this report through `ReportSchema.parse()`, it would throw. If it only reads `.content`, it may silently pass.

---

## 5. `tests/tui/intent-recognizer.test.ts` — Mock `parseJSON` vs Real

**Confirmed divergence:**

Mock `parseJSON` (line 20-22):
```ts
parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
  return schema.parse(JSON.parse(content.trim()));
}
```
- **No markdown block stripping** — calls `JSON.parse(content.trim())` directly
- Will throw `SyntaxError` if LLM returns JSON wrapped in ` ```json ``` ` blocks

Real `LLMClient.parseJSON` (`src/llm-client.ts` lines 57-72 + 150-161):
- `extractJSON(text)`: tries ` ```json\s*…``` ` first → then generic ` ```…``` ` → then bare string
- Handles all three forms before calling `JSON.parse`

**Impact:** `IntentRecognizer` uses `llmClient.parseJSON(rawContent, schema)` after `sendMessage`. Tests mock `sendMessage` to return bare JSON strings, so the simplified mock passes. But if the real Claude API wraps JSON in markdown blocks (common), the test mock would fail while the real implementation would succeed. The test mock is **under-testing** the real behavior.

---

## 6. CoreLoop Constructor — What an Integration Test Needs

`CoreLoop` constructor signature (`src/core-loop.ts` line 181):
```ts
constructor(deps: CoreLoopDeps, config?: LoopConfig)
```

`CoreLoopDeps` interface (lines 105-116) requires:
```ts
{
  stateManager: StateManager;
  observationEngine: ObservationEngine;
  gapCalculator: GapCalculatorModule;      // pure function module (not a class)
  driveScorer: DriveScorerModule;          // pure function module
  taskLifecycle: TaskLifecycle;
  satisficingJudge: SatisficingJudge;
  stallDetector: StallDetector;
  strategyManager: StrategyManager;
  reportingEngine: ReportingEngine;
  driveSystem: DriveSystem;
}
```

An integration test would need to construct or mock all 10 deps. The classes that themselves require `ILLMClient`: `ObservationEngine`, `TaskLifecycle`, `StrategyManager`. `StateManager` requires a `baseDir` string. `DriveSystem` requires `StateManager`. Most others require `StateManager` + optionally `ILLMClient`.

---

## 7. Source Files Without Corresponding Test Files

### Covered (test file exists):
- `src/adapter-layer.ts` → `tests/adapter-layer.test.ts`
- `src/adapters/claude-api.ts` → covered in `tests/adapter-layer.test.ts`
- `src/adapters/claude-code-cli.ts` → covered in `tests/adapter-layer.test.ts`
- `src/capability-detector.ts` → `tests/capability-detector.test.ts`
- `src/core-loop.ts` → `tests/core-loop.test.ts`
- `src/drive-scorer.ts` → `tests/drive-scorer.test.ts`
- `src/drive-system.ts` → `tests/drive-system.test.ts`
- `src/ethics-gate.ts` → `tests/ethics-gate.test.ts`
- `src/gap-calculator.ts` → `tests/gap-calculator.test.ts`
- `src/goal-negotiator.ts` → `tests/goal-negotiator.test.ts`
- `src/knowledge-manager.ts` → `tests/knowledge-manager.test.ts`
- `src/llm-client.ts` → `tests/llm-client.test.ts`
- `src/memory-lifecycle.ts` → `tests/memory-lifecycle.test.ts`
- `src/observation-engine.ts` → `tests/observation-engine.test.ts`
- `src/pid-manager.ts` → `tests/pid-manager.test.ts`
- `src/portfolio-manager.ts` → `tests/portfolio-manager.test.ts`
- `src/reporting-engine.ts` → `tests/reporting-engine.test.ts`
- `src/satisficing-judge.ts` → `tests/satisficing-judge.test.ts`
- `src/session-manager.ts` → `tests/session-manager.test.ts`
- `src/stall-detector.ts` → `tests/stall-detector.test.ts`
- `src/state-manager.ts` → `tests/state-manager.test.ts`
- `src/strategy-manager.ts` → `tests/strategy-manager.test.ts`
- `src/task-lifecycle.ts` → `tests/task-lifecycle.test.ts`
- `src/trust-manager.ts` → `tests/trust-manager.test.ts`
- `src/cli-runner.ts` → `tests/cli-runner.test.ts`
- `src/daemon-runner.ts` → `tests/daemon-runner.test.ts`
- `src/event-server.ts` → `tests/event-server.test.ts`
- `src/logger.ts` → `tests/logger.test.ts`
- `src/notification-dispatcher.ts` → `tests/notification-dispatcher.test.ts`
- `src/tui/intent-recognizer.ts` → `tests/tui/intent-recognizer.test.ts`
- `src/tui/actions.ts` → `tests/tui/actions.test.ts`
- `src/tui/use-loop.ts` → `tests/tui/use-loop.test.ts`

### **NOT covered (no test file):**
- `src/tui/markdown-renderer.ts` — **no test file**
- `src/tui/entry.ts` — **no test file** (TUI entry point, likely intentional — hard to test Ink apps)
- `src/index.ts` — **no test file** (barrel export, intentional)
- All `src/types/*.ts` files — **no test files** (type-only, intentional)

---

## Summary of Actionable Bugs Found

| # | File | Issue | Severity |
|---|------|-------|----------|
| 1 | `tests/tui/use-loop.test.ts:76` | Mock uses `isPermanentlyGated` but real method is `hasPermanentGate` | Medium — test passes only because mock is `as unknown as TrustManager` |
| 2 | `tests/tui/actions.test.ts:60` | `report_type: "daily"` — correct value is `"daily_summary"` | Low — fixture works if ActionHandler doesn't validate report type |
| 3 | `tests/tui/intent-recognizer.test.ts:20-22` | `parseJSON` mock has no markdown block handling | Low — tests pass because mock responses are bare JSON |
| 4 | Multiple test files | `parseJSON` inconsistencies — 3 files do NOT handle generic `` ``` `` blocks | Low — only matters for test fixtures using generic blocks |
| 5 | Multiple test files | Out-of-bounds silently returns `""` instead of throwing | Low — can mask missing fixture entries |
| 6 | No shared test helper | 11 files each define their own `createMockLLMClient` locally | Tech debt — not a bug, but a maintenance burden |
