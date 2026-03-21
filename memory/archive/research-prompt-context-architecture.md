# Motiva: LLM Call Sites & Prompt/Context Architecture

_Research date: 2026-03-22_

---

## 1. LLM Client Layer (`src/llm/`)

**Files:** `llm-client.ts`, `base-llm-client.ts`, `openai-client.ts`, `codex-llm-client.ts`, `ollama-client.ts`, `provider-factory.ts`, `provider-config.ts`

### Interface

```ts
interface ILLMClient {
  sendMessage(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse>;
  parseJSON<T>(content: string, schema: ZodSchema<T>): T;
}
```

All callers use `ILLMClient`, never the concrete class directly. The only message format is `{ role: "user"|"assistant", content: string }[]`. System prompt is passed as `options.system`.

### Implementations

| Class | Backend | Notes |
|-------|---------|-------|
| `LLMClient` | Anthropic SDK | Default model `claude-sonnet-4-20250514`, retry 3x w/ exponential backoff, `GuardrailRunner` hooks (before_model / after_model) |
| `OpenAIClient` | OpenAI SDK | Same `ILLMClient` interface |
| `CodexLLMClient` | OpenAI Codex CLI | Same interface, subprocess invocation |
| `OllamaClient` | Ollama REST | Same interface |
| `MockLLMClient` | In-memory | For tests |

### JSON Extraction

`BaseLLMClient.parseJSON()` strips markdown code fences (` ```json ``` ` → bare JSON) then Zod-validates. All LLM JSON responses follow this path.

---

## 2. All LLM Call Sites

### 2.1 Observation — `src/observation/observation-llm.ts` → `observeWithLLM()`

**Purpose:** Score a goal dimension 0.0–1.0 from workspace evidence.

**Prompt construction:**
- Fixed template string (no external file)
- Injects: `goalDescription`, `dimensionLabel`, `thresholdDescription`, `previousScore`, `workspaceContext` (truncated to 4000 chars)
- Few-shot calibration examples embedded in prompt
- If no workspace context → warns LLM to score 0.0
- **Critical rules** prepended to enforce evidence-only scoring

**Context source:** `workspaceContext` param (from `contextProvider`) OR fallback to `fetchGitDiffContext()` (git diff --stat + git diff, truncated to 3000 chars)

**Response schema:** `{ score: number, reason: string }`

---

### 2.2 Goal Negotiation — `src/goal/negotiator-prompts.ts` + `src/goal/negotiator-steps.ts`

Three LLM calls in the negotiation pipeline:

| Function | Prompt builder | Purpose |
|----------|----------------|---------|
| `runDecompositionStep()` | `buildDecompositionPrompt()` | Decompose goal → 5-7 measurable dimensions |
| per-dimension feasibility | `buildFeasibilityPrompt()` | Score dimension feasibility (realistic/ambitious/infeasible) |
| `buildResponsePrompt()` | `buildResponsePrompt()` | Generate human-readable acceptance/counter-proposal message |

**Context injected into decomposition prompt:**
- `goalDescription`, `constraints[]`
- `availableDataSources` (exact dimension names for overlap)
- `workspaceContext` (optional — if provided, LLM infers codebase-specific dimensions)

---

### 2.3 Task Generation — `src/execution/task-generation.ts` → `generateTask()`

**Purpose:** Generate a concrete, actionable task for a given goal + dimension.

**Prompt builder:** `src/execution/task-prompt-builder.ts` → `buildTaskGenerationPrompt()`

**Context sections assembled into prompt:**
1. Goal title + description (from `StateManager.loadGoal()`)
2. Dimension gap analysis (current value, target threshold, gap description)
3. Repository context (from `package.json` — name + description)
4. Adapter context (adapter-specific constraints, e.g., CLI sandbox rules for `openai_codex_cli`)
5. Knowledge context (`knowledgeContext` — Q&A pairs from `KnowledgeManager.getRelevantKnowledge()`)
6. Workspace state (`workspaceContext` — from `contextProvider`)
7. Existing tasks (dedup guard: list of prior task descriptions)
8. Last failure context (from `tasks/<goalId>/last-failure-context.json`)

**Also:** `generateTaskGroup()` decomposes a complex task into 2–5 subtasks via LLM (inline prompt string, not a builder function).

System prompt: `"You are a task generation assistant. Given a goal and target dimension, generate a concrete, actionable task."`

---

### 2.4 Task Verification — `src/execution/task-verifier.ts` → `verifyTask()`

**Purpose:** Judge whether a completed task passes its success criteria.

Prompt constructed inline; injects task description, success criteria, executor report/output.

Response schema: `{ verdict: "pass"|"partial"|"fail", reasoning: string, criteria_met: number, criteria_total: number }`

---

### 2.5 Ethics Gate — `src/traits/ethics-gate.ts` → `EthicsGate.check()` / `checkMeans()`

**Purpose:** Layer 2 LLM-based ethical evaluation (Layer 1 is hardcoded rule-based).

System prompt: `ETHICS_SYSTEM_PROMPT` — detailed "Motiva Persona" (gentle guardian) + evaluation instructions. Hardcoded constant in file.

User message: subject type + description + optional context + organizational constraints (injected from `CustomConstraintsConfig`).

Response schema: `{ verdict: "pass"|"flag"|"reject", category, reasoning, risks[], confidence }`. Auto-override: if `confidence < 0.6` and verdict=pass → promote to "flag".

---

### 2.6 Goal Suggestion — `src/goal/goal-suggest.ts` → `suggestGoals()`

**Purpose:** Generate measurable improvement goal suggestions from project context.

Prompt built by `buildSuggestGoalsPrompt()` — injects `context` (free-form project description), `maxSuggestions`, `existingGoals` (dedup list).

Response schema: `GoalSuggestionListSchema` — array of `{ title, description, rationale, dimensions_hint[] }`.

Also: `buildCapabilityCheckPrompt()` — checks whether adapter capabilities cover required dimensions.

---

### 2.7 Knowledge Manager — `src/knowledge/knowledge-manager.ts` → `detectKnowledgeGap()`, `generateAcquisitionTask()`

**Purpose:** Detect knowledge gaps; generate research tasks to fill them.

Fast-path heuristics (no LLM): confidence < 0.3 → interpretation_difficulty; empty strategies → strategy_deadlock.

LLM fallback: inline prompt string with observations + strategies + confidence.

---

### 2.8 Memory Distillation — `src/knowledge/memory-distill.ts` → `extractPatterns()` + `distillLessons()`

Two sequential LLM calls, called by `compressToLongTerm()`:

1. `extractPatterns()` — analyze experience log entries → `{ patterns: string[] }`
2. `distillLessons()` — convert patterns → structured `LessonEntry` objects with type/context/lesson/tags

System prompts: `"You are a pattern extraction engine..."` / `"You are a lesson distillation engine..."` — hardcoded strings.

---

### 2.9 Other LLM Call Sites

| File | Function | Purpose |
|------|----------|---------|
| `src/execution/reflection-generator.ts` | `generateReflection()` | Post-task reflection |
| `src/execution/impact-analyzer.ts` | `analyzeImpact()` | Analyze task impact on dimensions |
| `src/execution/result-reconciler.ts` | `reconcileResults()` | Reconcile parallel task results |
| `src/goal/goal-decomposer.ts` | `decomposeGoal()` | Decompose parent goal into subgoals |
| `src/goal/goal-tree-quality.ts` | quality checks | Tree coherence evaluation |
| `src/goal/goal-dependency-graph.ts` | dependency inference | Infer goal dependencies |
| `src/knowledge/knowledge-revalidation.ts` | `revalidateEntry()` | Revalidate stale knowledge entries |
| `src/knowledge/knowledge-transfer.ts` | `transferKnowledge()` | Cross-goal knowledge transfer |
| `src/knowledge/learning-pipeline.ts` | pipeline steps | Learning pipeline processing |
| `src/traits/curiosity-proposals.ts` | curiosity suggestions | Generate exploration proposals |
| `src/tui/intent-recognizer.ts` | `recognizeIntent()` | Parse TUI chat intent |
| `src/strategy/strategy-template-registry.ts` | template generation | Strategy template generation |
| `src/strategy/strategy-manager-base.ts` | strategy selection | LLM-guided strategy selection |
| `src/observation/capability-detector.ts` | `detectGoalCapabilityGap()` | Check capability gaps |

---

## 3. Context Provider System

**Core file:** `src/observation/workspace-context.ts` → `createWorkspaceContextProvider()`

### What it does

Returns a `(goalId, dimensionName) => Promise<string>` function. Called before task generation and observation.

### Selection algorithm (priority order):

1. **Always-include:** `README.md`, `package.json` from `workDir`
2. **Path-matched:** Absolute paths extracted from goal description (via regex) — read if within allowed dirs
3. **Explicit relative paths:** Relative paths mentioned in goal description — read if accessible
4. **Filename keyword match:** Keywords extracted from goal description + dimension name; match against all filenames (depth ≤ 3)
5. **Content keyword match:** Fallback — scan file contents (first 20KB) for keywords
6. Cap: `maxFiles` (default: 5) for keyword-matched candidates; always-include and path-matched are outside the cap

### Output format

Markdown with sections: `# Workspace: <dir>`, `## Directory listing`, `## <filename>` blocks with fenced code.

### Integration into CoreLoop

`src/loop/core-loop-phases-b.ts` (Phase 6/7 — task generation):
1. Calls `ctx.deps.contextProvider(goalId, topDimension)` to get `workspaceContext`
2. Calls `ctx.deps.knowledgeManager.getRelevantKnowledge(goalId, topDimension)` → formats as Q&A pairs → `knowledgeContext`
3. Both passed to `generateTask()` → `buildTaskGenerationPrompt()`

`contextProvider` is declared as optional in `CoreLoopDeps` (defined in `src/loop/core-loop-types.ts`). It's injected at setup time (`src/cli/setup.ts`, `src/tui/entry.ts`).

### Fallback

If `contextProvider` is not provided, `observeWithLLM()` falls back to `fetchGitDiffContext()` (git diff output, up to 3000 chars).

---

## 4. Memory System Integration with Prompts

### How memory reaches prompts

```
MemoryLifecycleManager (L1–L3 tiers)
  ↓ selectForWorkingMemory() / selectForWorkingMemorySemantic()
  ↓ KnowledgeManager.getRelevantKnowledge()
  ↓ Formatted as "Q: ...\nA: ..." pairs → knowledgeContext string
  ↓ Injected into buildTaskGenerationPrompt() as §"Relevant domain knowledge"
```

### Memory tier system (`src/knowledge/memory-selection.ts`)

Three tiers: **core** (high-dissatisfaction, active goals) → **recall** → **archival**.

- Tier classification: rule-based (`classifyTier()`) + optional LLM override (`llmClassifyTier()`)
- Dynamic budget: `computeDynamicBudget(maxDissatisfaction)` — allocates core/recall/archival ratio based on drive urgency
- Selection: core-guaranteed slots filled first, then recall, then archival (semantic search via `VectorIndex` for archival tier)
- Cross-goal lessons: 25% of budget reserved for `queryCrossGoalLessons()`

### Memory → Prompt path

1. `CoreLoop` phase 6 calls `knowledgeManager.getRelevantKnowledge(goalId, dimension)`
2. Returns `KnowledgeEntry[]` — each with `question` + `answer` fields
3. Formatted inline as `"Q: {question}\nA: {answer}"` — **no structured injection**; just a text block
4. Inserted as `knowledgeSection` in `buildTaskGenerationPrompt()`

### Gap: Memory selection → observation prompt

`selectForWorkingMemory()` results (ShortTermEntry, LessonEntry) are NOT currently injected into the **observation prompt** (`observeWithLLM()`). Only workspace file content (from `contextProvider`) reaches the observation LLM. Lessons learned from past loops do NOT inform scoring — **this is a gap.**

---

## 5. Prompt Template Architecture

There are NO external template files (no `.hbs`, `.jinja`, `.txt` template files). All prompts are:

- **Inline string construction** — template literals built at call site (most common)
- **Prompt builder functions** — dedicated functions in co-located files:
  - `src/goal/negotiator-prompts.ts`: `buildDecompositionPrompt()`, `buildFeasibilityPrompt()`, `buildResponsePrompt()`
  - `src/execution/task-prompt-builder.ts`: `buildTaskGenerationPrompt()`
  - `src/goal/goal-suggest.ts`: `buildSuggestGoalsPrompt()`, `buildCapabilityCheckPrompt()`
- **Hardcoded system prompts** — constants at module scope (e.g., `ETHICS_SYSTEM_PROMPT` in ethics-gate.ts)

### Structural pattern for all prompts

1. System prompt (role/persona/output format rules) — passed as `options.system`
2. User message (dynamic data: goal context, workspace, knowledge, constraints)
3. Response always expected as JSON (either raw or inside ` ```json ``` ` fences)
4. All responses validated through `llmClient.parseJSON(content, ZodSchema)`

---

## 6. Key Architectural Gaps

1. **Memory lessons not in observation prompt** — `observeWithLLM()` only sees workspace files + git diff, never `LessonEntry` from long-term memory
2. **No structured prompt versioning** — prompts are inline strings; no version tracking or A/B mechanism
3. **Knowledge context is plain text** — `knowledgeContext` is raw Q&A concatenation with no priority/relevance ordering applied at injection
4. **`contextProvider` is optional** — if not injected, observation falls back to git diff only; task generation gets no workspace signal
5. **No shared system prompt** — each LLM call site has its own system prompt; no central persona/instruction registry

---

## 7. Data Flow Diagram (simplified)

```
Goal + Dimension
       │
       ├─→ contextProvider(goalId, dim) ─→ workspace files (README, keyword-matched files)
       │                                     │
       ├─→ KnowledgeManager                  │
       │   .getRelevantKnowledge()            │
       │   (selectForWorkingMemory()          │
       │    via MemoryLifecycleManager) ───→ knowledgeContext (Q&A pairs)
       │                                     │
       └─→ buildTaskGenerationPrompt() ←─────┘
           [goal + dim + repo + adapter + workspace + knowledge + prior_tasks + last_failure]
                │
                └─→ llmClient.sendMessage() → Task JSON
```

```
Observation pipeline:
  contextProvider(goalId, dim) → workspaceContext
       OR  fetchGitDiffContext() (fallback)
              │
              └─→ observeWithLLM() prompt
                  [goal + dim + threshold + workspace + previous_score]
                       │
                       └─→ { score: 0.0–1.0, reason }
```
