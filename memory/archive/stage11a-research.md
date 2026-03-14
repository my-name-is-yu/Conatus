---
name: Stage 11A Research — Ethics Gate Layer 1 + Task Means Check
description: Implementation spec for Phase 11A: Layer 1 category-based blocklist, checkMeans TaskLifecycle integration, and custom constraints
type: project
---

# Stage 11A Implementation Spec

## 1. Design Requirements

### Source: `docs/design/goal-ethics.md`

---

### Layer 1 (§4, §8, §9 Phase 2)

**Purpose**: LLM-independent, jailbreak-resistant fast filter placed _before_ Layer 2 LLM judgment.

**Design contract**:
- Classifies **intent and context**, not keywords. "hacking" in a CTF context must pass; "exploit a known vulnerability to harm" must reject.
- Must run synchronously (no LLM call).
- Hardcoded in source — cannot be modified via prompt or config.
- A reject from Layer 1 short-circuits: Layer 2 is never called.

**6 categories for immediate reject** (§3 "明確なNG"):

| Category key | Description |
|---|---|
| `illegal_activity` | Unauthorized access, theft, fraud, copyright infringement, tax evasion |
| `direct_harm` | Plans to hurt people, harassment automation, reputational damage campaigns |
| `privacy_violation` | Unauthorized personal data acquisition/sale, unconsented tracking, misuse of PII |
| `deception_impersonation` | False identity contact, phishing, mass disinformation generation |
| `security_breach` | Creation/use of unauthorized access tools, malicious exploitation of vulnerabilities |
| `discrimination_harassment_automation` | Organized attacks on protected attributes, automated discriminatory selection |

**Implementation approach** (per §8): not keyword matching but _intent-level classification rules_. Implemented as an array of rule objects, each with a category, pattern logic, and a description. An input matches a rule if and only if its intent falls within the rule's scope, regardless of exact wording.

**Pipeline position**: `Layer1 check → [reject immediately] or [pass to Layer 2]`

---

### checkMeans (§5 "タスク生成後の手段チェック")

**Purpose**: After `TaskLifecycle.generateTask()` produces a task, check whether the _execution means_ are ethical even if the goal/subgoal is approved.

**What to check** (per §5):
- Execution means (what tool is used and what it does)
- Anticipated side effects (unintended external impact)
- Data accessed and its scope of use

**Integration point in `runTaskCycle()`**: Step 3a (already stubbed at lines 666-712 in current `task-lifecycle.ts`). The stub is fully implemented — `this.ethicsGate.checkMeans(task.id, task.work_description, task.approach)` is already called. The FIXME note referenced in the stage11 plan refers to the original pre-Stage 10 state, **not the current state**.

**Verdict handling** (already implemented at lines 673-711):
- `reject` → returns `{action: "discard"}` immediately
- `flag` → routes through `approvalFn`; if denied → `{action: "approval_denied"}`
- `pass` → falls through to capability check

---

### Custom Constraints (§9 Phase 2)

**Purpose**: Organization-specific policy rules that extend the built-in 6 categories.

**Scope**: Two levels:
- `applies_to: "goal"` — checked during goal/subgoal evaluation via `check()`
- `applies_to: "task_means"` — checked during means evaluation via `checkMeans()`

**Config format** (from design doc §9):
```yaml
ethics_constraints:
  - description: "競合他社に関するデータ収集は一切行わない"
    applies_to: "goal"
  - description: "外部APIへの顧客データ送信は禁止"
    applies_to: "task_means"
```

**Behavior**: Custom constraints are evaluated in Layer 1 (before LLM). They are user-defined text rules. Matching is intent-based (requires LLM or heuristic — see Gap Analysis below).

---

## 2. Current State

### `src/ethics-gate.ts` (274 lines) — Confirmed

**What is implemented**:
- `check(subjectType, subjectId, description, context?)` — full LLM-based Layer 2 evaluation
- `checkMeans(taskId, taskDescription, means)` — LLM-based means evaluation (Layer 2)
- `getLogs(filter?)` — log retrieval with optional filtering
- Log persistence via StateManager (`ethics/ethics-log.json`)
- `applyConfidenceOverride()` — auto-flag when `confidence < 0.6` and verdict is `pass`
- `parseVerdictSafe()` — conservative fallback (`flag`, `parse_error`) on JSON parse failure
- ETHICS_SYSTEM_PROMPT with persona + evaluation rules embedded
- `buildUserMessage()` and `buildMeansUserMessage()` as separate prompt builders

**What is NOT implemented** (gaps):
- Layer 1 (`checkLayer1()` method, category-based blocklist rules, rule evaluation logic)
- Custom constraints support (no `CustomConstraint` type, no loading, no application)
- Constructor does not accept constraints config
- No `layer1_triggered` field on log entries to distinguish Layer 1 vs Layer 2 rejections
- No public method to add/update custom constraints at runtime

### `src/task-lifecycle.ts` (lines 660-712) — Confirmed

**Current state**: `checkMeans()` is ALREADY integrated. The `runTaskCycle()` method calls `this.ethicsGate.checkMeans()` at step 3a with full reject/flag/pass handling. This was completed in Stage 10.

**What remains for Stage 11A**: No changes to the existing flow are needed. The integration gap the plan refers to was resolved. However:
- No test coverage exists for the ethics means check in `task-lifecycle.test.ts` (Grep found 0 matches for "ethics", "checkMeans", "ethicsGate")

### `src/types/ethics.ts` (37 lines) — Confirmed

**What exists**:
- `EthicsVerdictSchema` / `EthicsVerdict`
- `EthicsSubjectTypeEnum` / `EthicsSubjectType` (`"goal" | "subgoal" | "task"`)
- `EthicsLogSchema` / `EthicsLog` (includes optional `rejection_delivered` and `user_confirmation`)

**What is NOT defined**:
- `Layer1Rule` type (category, patterns/logic, description)
- `CustomConstraint` type (`description: string`, `applies_to: "goal" | "task_means"`)
- `CustomConstraintsConfig` type (array of `CustomConstraint`)
- No `layer1_triggered` flag on `EthicsLog` to track which layer fired

### `tests/ethics-gate.test.ts` (589 lines) — Confirmed

**Existing coverage** (~40 tests):
- `check()`: pass, reject, flag, auto-flag on low confidence, boundary condition, context param
- `checkMeans()`: 5 tests (pass/flag/reject verdicts, auto-flag, log persistence)
- `getLogs()`: filtering by subjectId, verdict, combined filters
- Log persistence: file creation, JSON array format, cross-instance read, accumulation, unique IDs, timestamps, no .tmp files
- JSON parse failure: 5 tests for `check()`, 1 for `checkMeans()`
- LLM call failure propagation
- Log structure validation

**NOT tested**:
- Layer 1 evaluation (doesn't exist yet)
- Custom constraints evaluation
- Layer 1 + Layer 2 pipeline interaction (Layer 1 reject prevents Layer 2 call)
- `log.layer1_triggered` field (if added)

### `tests/task-lifecycle.test.ts` — Confirmed gap

No tests for `ethicsGate` integration in `runTaskCycle`. The ethics means check stub at lines 666-712 has zero test coverage.

---

## 3. Gap Analysis

### Gap 1: Layer 1 is entirely missing from `src/ethics-gate.ts`

Need to add:
1. A `checkLayer1(description: string): EthicsVerdict | null` private method
   - Returns `EthicsVerdict` with `verdict: "reject"` if a Layer 1 rule matches
   - Returns `null` if no rule matches (pass to Layer 2)
2. An array of hardcoded `Layer1Rule` objects covering the 6 categories
3. Modify `check()` to call `checkLayer1()` first; if non-null result, log and return immediately without calling LLM
4. Modify `checkMeans()` similarly — Layer 1 also applies to means evaluation
5. (Optional but recommended) Add `layer1_triggered?: boolean` to log entries so auditors can distinguish Layer 1 vs Layer 2 rejections

**Layer 1 rule evaluation approach**: The design says "intent-level classification, not keyword matching." For the MVP Layer 1 implementation, a pragmatic approach is a set of pattern functions that evaluate obvious explicit intent markers (e.g., phrases that unambiguously indicate illegal access, explicit harm statements) rather than pure regex. Each rule function takes the description string and returns true/false. This avoids a full LLM call while remaining more robust than naive keyword matching.

### Gap 2: Custom constraints are entirely missing

Need to add:
1. `CustomConstraint` and `CustomConstraintsConfig` types in `src/types/ethics.ts`
2. `EthicsGate` constructor to accept optional `CustomConstraintsConfig`
3. Custom constraint evaluation in `check()` and `checkMeans()` — evaluated as part of Layer 1 (before LLM)
4. Since custom constraints are free-text descriptions, matching them purely without LLM is impractical. **Design decision needed**: either (a) evaluate custom constraints via LLM as a third sub-step within Layer 1, or (b) pass them to Layer 2 LLM prompt as additional context. Option (b) is simpler and consistent with the existing LLM prompt approach.

**Recommended approach for custom constraints**: Inject them into `buildUserMessage()` / `buildMeansUserMessage()` as additional context lines in the Layer 2 prompt. This avoids a separate LLM call for custom constraint evaluation while still providing meaningful enforcement. Pure hardcoded Layer 1 rules cover the 6 built-in categories; custom constraints are surfaced through Layer 2.

### Gap 3: `task-lifecycle.test.ts` has no ethics means check tests

The integration at lines 666-712 of `task-lifecycle.ts` needs test coverage:
- `runTaskCycle()` discards task when ethics `reject`
- `runTaskCycle()` calls `approvalFn` when ethics `flag`
- `runTaskCycle()` proceeds when ethics `pass`
- `runTaskCycle()` proceeds when `ethicsGate` is not injected (undefined)

### Gap 4: `EthicsLog` schema does not record which layer triggered

Add optional `layer1_triggered?: boolean` to `EthicsLogSchema` and `EthicsLog`. This supports the audit/statistics requirement from §9 Phase 2 ("誤拒否率" tracking). When Layer 1 fires, `layer1_triggered: true`; when Layer 2 fires or no rejection, field is omitted or `false`.

---

## 4. Type Definitions Needed

### In `src/types/ethics.ts`

```typescript
// Layer 1 rule: one entry per category in the built-in blocklist
export const Layer1RuleCategoryEnum = z.enum([
  "illegal_activity",
  "direct_harm",
  "privacy_violation",
  "deception_impersonation",
  "security_breach",
  "discrimination_harassment_automation",
]);
export type Layer1RuleCategory = z.infer<typeof Layer1RuleCategoryEnum>;

export interface Layer1Rule {
  category: Layer1RuleCategory;
  description: string;
  // Returns true if the input description matches this rule's intent
  matches: (input: string) => boolean;
}

// Custom constraints (user-configurable)
export const CustomConstraintSchema = z.object({
  description: z.string(),
  applies_to: z.enum(["goal", "task_means"]),
});
export type CustomConstraint = z.infer<typeof CustomConstraintSchema>;

export const CustomConstraintsConfigSchema = z.object({
  constraints: z.array(CustomConstraintSchema),
});
export type CustomConstraintsConfig = z.infer<typeof CustomConstraintsConfigSchema>;
```

### Update to `EthicsLogSchema` (in `src/types/ethics.ts`)

```typescript
export const EthicsLogSchema = z.object({
  // ... existing fields ...
  layer1_triggered: z.boolean().optional(),  // ADD: true when Layer 1 fired
  // ... existing optional fields ...
});
```

---

## 5. Integration Points

### Layer 1 → Layer 2 pipeline in `EthicsGate.check()`

```
check(subjectType, subjectId, description, context?) →
  1. checkLayer1(description)
     → non-null: log(layer1_triggered=true) + return immediately (no LLM call)
     → null: proceed
  2. [optional] evaluate custom constraints (inject into prompt OR separate check)
  3. LLM call (Layer 2) — existing code
  4. applyConfidenceOverride
  5. log + return
```

### Layer 1 → Layer 2 pipeline in `EthicsGate.checkMeans()`

Same structure as `check()` but uses `buildMeansUserMessage()` for Layer 2:
```
checkMeans(taskId, taskDescription, means) →
  1. checkLayer1(means)  [or checkLayer1(taskDescription + " " + means)]
     → non-null: log(layer1_triggered=true) + return immediately
     → null: proceed
  2. LLM call (Layer 2, means-specific prompt)
  3. applyConfidenceOverride
  4. log + return
```

### `EthicsGate` constructor update

```typescript
constructor(
  stateManager: StateManager,
  llmClient: ILLMClient,
  customConstraints?: CustomConstraintsConfig  // ADD
)
```

### TaskLifecycle integration (already complete — no changes needed)

`runTaskCycle()` lines 666-712 already call `this.ethicsGate.checkMeans()` with correct behavior for all three verdicts. No code changes needed to `task-lifecycle.ts` for Stage 11A. Only test coverage needs to be added.

---

## 6. Test Requirements (~80 tests target)

### `tests/ethics-gate.test.ts` additions (~50 new tests)

**Layer 1 — built-in category rules** (~30 tests, one describe block per category):

For each of the 6 categories, test at minimum:
- A clearly matching input → `reject` verdict returned without LLM call
- A superficially similar but legitimate input → Layer 1 does not fire (falls through to Layer 2)
- Example for `illegal_activity`: "Gain unauthorized access to competitor servers" → reject; "Run authorized penetration test on our own system" → Layer 1 passes

Also test:
- Layer 1 reject sets `layer1_triggered: true` in log
- Layer 1 reject does NOT call LLM (mock LLM receives zero calls)
- Layer 1 pass does call LLM (mock LLM receives one call)
- Layer 1 reject on `checkMeans()` works identically to `check()`

**Custom constraints** (~12 tests):

- `EthicsGate` constructed without constraints behaves as before (no regression)
- Goal-level constraint: description matches → `flag` or `reject` verdict
- Task-means constraint: means matches → `flag` or `reject` verdict
- Goal-level constraint does NOT fire on `checkMeans()` call
- Task-means constraint does NOT fire on `check()` goal call
- Custom constraints are injected into Layer 2 prompt (verify via mock capture or log inspection)
- Multiple custom constraints: all evaluated
- Empty constraints array: behaves as no constraints

**Layer 1 + Layer 2 pipeline interaction** (~8 tests):

- When Layer 1 rejects, LLM is not called (mock LLM receives 0 calls)
- When Layer 1 passes, LLM is called exactly once
- Layer 1 reject log entry has `layer1_triggered: true`
- Layer 2 reject log entry has `layer1_triggered` undefined or false
- `getLogs({ verdict: "reject" })` returns both Layer 1 and Layer 2 rejects
- Pipeline with custom constraint that injects into Layer 2: LLM called once, custom context present

### `tests/task-lifecycle.test.ts` additions (~30 new tests)

**Ethics means check in `runTaskCycle()`** — new describe block:

- `ethicsGate` not provided → ethics check skipped, task proceeds normally
- Ethics `pass` → task proceeds to capability check (no short-circuit)
- Ethics `reject` → `action: "discard"` returned immediately; adapter never called
- Ethics `reject` → verification result has `verdict: "fail"` and evidence contains ethics reasoning
- Ethics `flag` + `approvalFn` returns true → task proceeds to capability check
- Ethics `flag` + `approvalFn` returns false → `action: "approval_denied"` returned; adapter never called
- Ethics `flag` + `approvalFn` returns false → verification evidence contains "Ethics flag: approval denied"
- `checkMeans` receives `task.id`, `task.work_description`, `task.approach` as arguments
- Ethics error (LLM throws) → propagates as thrown error from `runTaskCycle()`

---

## 7. Implementation Checklist Summary

| File | Change | Status |
|---|---|---|
| `src/types/ethics.ts` | Add `Layer1RuleCategoryEnum`, `Layer1Rule`, `CustomConstraintSchema`, `CustomConstraintsConfigSchema`, `layer1_triggered` on `EthicsLogSchema` | Not started |
| `src/ethics-gate.ts` | Add `checkLayer1()` private method + 6 built-in rules, update `check()` and `checkMeans()` to run Layer 1 first, update constructor to accept `CustomConstraintsConfig`, inject custom constraints into prompts | Not started |
| `src/task-lifecycle.ts` | No changes needed — integration already complete at lines 666-712 | Already done |
| `tests/ethics-gate.test.ts` | Add ~50 tests for Layer 1 (6 categories), custom constraints, pipeline interaction | Not started |
| `tests/task-lifecycle.test.ts` | Add ~30 tests for ethics means check in `runTaskCycle()` | Not started |

---

## 8. Key Design Decisions to Confirm Before Implementation

1. **Layer 1 matching implementation**: Pattern functions (string analysis) vs. pure LLM-free heuristics. The design says "intent-level, not keyword" — this implies more than regex but less than LLM. Recommend: per-category pattern functions using a curated set of intent-indicating phrases as strong signals, combined with negation checks for legitimate contexts.

2. **Custom constraint evaluation layer**: Inject into Layer 2 prompt (recommended — simpler, no extra LLM call) vs. separate Layer 1 LLM call. The design does not specify — recommend Layer 2 prompt injection.

3. **`layer1_triggered` field**: Optional boolean on log (recommended for auditability per §9 Phase 2 statistics requirement).

4. **`checkMeans()` Layer 1 input**: Check only `means` string, or combined `taskDescription + means`. Recommend combined — a benign means for a harmful task description should also be caught.
