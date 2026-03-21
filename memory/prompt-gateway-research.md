# Prompt Gateway Research — Interface Reference

Generated: 2026-03-22
Purpose: Reference for implementing `src/prompt/` module (PromptGateway + ContextAssembler)

---

## 1. ILLMClient Interface

**File**: `src/llm/llm-client.ts` (lines 10–39)

```typescript
export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMRequestOptions {
  model?: string;
  max_tokens?: number;
  system?: string;       // system prompt
  temperature?: number;
}

export interface LLMResponse {
  content: string;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string;
}

export interface ILLMClient {
  sendMessage(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse>;
  parseJSON<T>(content: string, schema: ZodSchema<T>): T;
}
```

**Notes**:
- `system` is passed as `options.system`, NOT as a separate message — **Confirmed**
- All existing callers use pattern: `llmClient.sendMessage([{ role: "user", content: prompt }], { system: "...", max_tokens: N, temperature: 0 })`
- `parseJSON` wraps `extractJSON` + Zod parse in a single step
- `MockLLMClient` is available for tests (takes `string[]` of responses)
- Default model: `claude-sonnet-4-20250514`

---

## 2. context-budget.ts

**File**: `src/execution/context-budget.ts`

```typescript
export interface BudgetAllocation {
  goalDefinition: number;    // 20%
  observations: number;      // 30%
  knowledge: number;         // 30%
  transferKnowledge: number; // 15%
  meta: number;              // 5%
}

export function allocateBudget(totalBudget: number): BudgetAllocation

export function allocateTierBudget(totalTokens: number): TierBudget
// → { core: 50%, recall: 35%, archival: remaining }

export function estimateTokens(text: string): number
// Heuristic: Math.ceil(text.length / 4)

export function selectWithinBudget<T extends { text: string; similarity: number }>(
  candidates: T[],
  budgetTokens: number
): T[]

export function trimToBudget(
  allocation: BudgetAllocation,
  actualUsage: Record<keyof BudgetAllocation, number>,
  totalBudget: number
): BudgetAllocation
// Trim order (lowest priority first): meta, transferKnowledge, goalDefinition, knowledge, observations
```

**Note**: `allocateBudget` is currently NOT wired to any LLM call. The design doc confirms this is a "Critical Gap" to fix. — **Confirmed**

---

## 3. context-provider.ts (workspace context)

**File**: `src/observation/context-provider.ts`

```typescript
export interface ContextItem {
  label: string;
  content: string;
  memory_tier: MemoryTier;  // "core" | "recall" | "archival"
}

export async function buildWorkspaceContext(
  goalId: string,
  dimensionName: string,
  options?: { cwd?: string; maxFileContentLines?: number }
): Promise<string>

export async function buildWorkspaceContextItems(
  goalId: string,
  dimensionName: string,
  options?: { cwd?: string; maxFileContentLines?: number; maxItems?: number }
): Promise<ContextItem[]>

export function selectByTier(items: ContextItem[], maxItems: number): ContextItem[]
export function dimensionNameToSearchTerms(dimensionName: string): string[]
```

**Also exists**: `src/observation/workspace-context.ts`

```typescript
export function createWorkspaceContextProvider(
  options: WorkspaceContextOptions,
  getGoalDescription: (goalId: string) => string | undefined | Promise<string | undefined>
): (goalId: string, dimensionName: string) => Promise<string>
```

**Note**: The design says `workspace-context.ts` should be absorbed into `ContextAssembler` internals. `context-provider.ts` (newer) is the preferred implementation with tier support. — **Confirmed**

---

## 4. Memory Tier Types

**File**: `src/types/memory-lifecycle.ts`

```typescript
export const MemoryTierSchema = z.enum(["core", "recall", "archival"]);
export type MemoryTier = z.infer<typeof MemoryTierSchema>;

export const TierBudgetSchema = z.object({
  core: z.number().min(0).max(1),
  recall: z.number().min(0).max(1),
  archival: z.number().min(0).max(1),
});
export type TierBudget = z.infer<typeof TierBudgetSchema>;
```

**Design doc mapping** (hot/warm/cold/archival from design doc → actual tier names):
- hot → `"core"` tier
- warm → `"recall"` tier
- cold/archival → `"archival"` tier

**Tier classification logic**: `src/knowledge/memory-tier.ts`

```typescript
export function classifyTier(
  entry: ShortTermEntry | MemoryIndexEntry,
  activeGoalIds: string[],
  completedGoalIds: string[],
  satisfiedDimensions?: string[],
  highDissatisfactionDimensions?: string[]
): MemoryTier

export function computeDynamicBudget(maxDissatisfaction: number): TierBudget
// maxDissatisfaction > 0.7 → { core: 0.70, recall: 0.25, archival: 0.05 }
// maxDissatisfaction > 0.4 → { core: 0.60, recall: 0.30, archival: 0.10 }
// else                     → { core: 0.50, recall: 0.35, archival: 0.15 }

export async function llmClassifyTier(
  entries: MemoryIndexEntry[],
  activeGoalContext: { goalId: string; dimensions: string[]; gap?: number },
  llmClient: { generateStructured: (...args: any[]) => Promise<any> }
): Promise<Map<string, MemoryTier>>
// WARNING: llmClassifyTier uses `generateStructured` not ILLMClient — design doc flags this as a Minor Gap
```

---

## 5. MemoryLifecycleManager

**File**: `src/knowledge/memory-lifecycle.ts`

**Constructor**:
```typescript
constructor(
  baseDir: string,
  llmClient: ILLMClient,
  config?: Partial<RetentionConfig>,
  embeddingClient?: IEmbeddingClient,
  vectorIndex?: VectorIndex,
  driveScorer?: IDriveScorer
)
```

**Key methods for PromptGateway**:
```typescript
async selectForWorkingMemory(
  goalId: string,
  dimensions: string[],
  tags: string[],
  maxEntries: number = 10
): Promise<{ shortTerm: ShortTermEntry[]; lessons: LessonEntry[] }>

async selectForWorkingMemoryTierAware(
  goalId: string,
  dimensions: string[],
  tags: string[],
  maxEntries: number,
  activeGoalIds: string[],
  completedGoalIds: string[],
  satisfiedDimensions: string[],
  highDissatisfactionDimensions: string[],
  maxDissatisfaction: number
): Promise<{ shortTerm: ShortTermEntry[]; lessons: LessonEntry[] }>

async selectForWorkingMemorySemantic(
  goalId: string,
  query: string,
  dimensions: string[],
  tags: string[],
  maxEntries: number = 10,
  driveScores?: Array<{ dimension: string; dissatisfaction: number; deadline: number }>
): Promise<{ shortTerm: ShortTermEntry[]; lessons: LessonEntry[] }>

async searchCrossGoalLessons(query: string, topK = 5): Promise<LessonEntry[]>
```

**Lesson access**: via `selectForWorkingMemory()` → returns `{ lessons: LessonEntry[] }`. No separate "get lessons" method.

---

## 6. memory-selection.ts

**File**: `src/knowledge/memory-selection.ts`

```typescript
export interface MemorySelectionDeps {
  memoryDir: string;
  vectorIndex?: VectorIndex;
  driveScorer?: IDriveScorer;
}

export async function selectForWorkingMemory(
  deps: MemorySelectionDeps,
  goalId: string,
  dimensions: string[],
  tags: string[],
  maxEntries: number = 10,
  activeGoalIds?: string[],
  completedGoalIds?: string[],
  satisfiedDimensions?: string[],
  highDissatisfactionDimensions?: string[],
  maxDissatisfaction?: number,
  useLLMClassification?: boolean,
  llmClient?: { generateStructured: (...args: any[]) => Promise<any> }
): Promise<{ shortTerm: ShortTermEntry[]; lessons: LessonEntry[] }>

export function relevanceScore(
  deps: Pick<MemorySelectionDeps, "driveScorer">,
  entry: ShortTermEntry,
  context: { goalId: string; dimensions: string[]; tags: string[] }
): number
// Score = tag_match_ratio * drive_weight * freshness_factor

export async function selectForWorkingMemorySemantic(...)
export async function searchCrossGoalLessons(...)
```

**Note**: The design doc references `computeRelevanceScore()` but the actual function is `relevanceScore()` — **Confirmed** (no `computeRelevanceScore` exists anywhere in `src/`).

---

## 7. Key Types

### LessonEntry

**File**: `src/types/memory-lifecycle.ts` (lines 56–83)

```typescript
export type LessonEntry = {
  lesson_id: string;
  type: "strategy_outcome" | "success_pattern" | "failure_pattern";
  goal_id: string;
  context: string;
  action?: string;
  outcome?: string;
  lesson: string;              // Main lesson text for injection
  source_loops: string[];
  extracted_at: string;        // datetime
  relevance_tags: string[];
  failure_reason?: string;     // for failure_pattern
  avoidance_hint?: string;
  applicability?: string;      // for success_pattern
  status: "active" | "superseded" | "archived";
  superseded_by?: string;
}
```

### ReflectionNote

**File**: `src/types/reflection.ts`

```typescript
export type ReflectionNote = {
  reflection_id: string;
  goal_id: string;
  strategy_id: string | null;
  task_id: string;
  what_was_attempted: string;
  outcome: "success" | "partial" | "fail";
  why_it_worked_or_failed: string;
  what_to_do_differently: string;
  created_at: string;
}
```

### KnowledgeEntry

**File**: `src/types/knowledge.ts` (lines 23–35)

```typescript
export type KnowledgeEntry = {
  entry_id: string;
  question: string;
  answer: string;
  sources: Source[];
  confidence: number;    // 0–1
  acquired_at: string;
  acquisition_task_id: string;
  superseded_by: string | null;
  tags: string[];
  embedding_id: string | null;
}
```

### StrategyTemplate

**File**: `src/types/cross-portfolio.ts` (lines 38–49)

```typescript
export type StrategyTemplate = {
  template_id: string;
  source_goal_id: string;
  source_strategy_id: string;
  hypothesis_pattern: string;   // Key field for injection
  domain_tags: string[];
  effectiveness_score: number;  // 0–1
  applicable_dimensions: string[];
  embedding_id: string | null;
  created_at: string;
}
```

---

## 8. formatReflectionsForPrompt

**File**: `src/execution/reflection-generator.ts` (lines 166–174)

```typescript
export function formatReflectionsForPrompt(reflections: ReflectionNote[]): string
// Returns: "## Past Reflections (learn from these)\n- [outcome] Attempted: ... → Why: ... → Next time: ..."
// Returns "" if reflections.length === 0

export async function getReflectionsForGoal(
  knowledgeManager: KnowledgeManager,
  goalId: string,
  limit = 5,
): Promise<ReflectionNote[]>
// Loads reflections from KnowledgeManager, tag: ["reflection", `goal:${goalId}`]

export async function generateReflection(params: {
  task: Task;
  verificationResult: VerificationResult;
  goalId: string;
  strategyId?: string;
  llmClient: ILLMClient;
  logger?: ReflectionLogger;
}): Promise<ReflectionNote>
```

---

## 9. Existing LLM Call Patterns

All callers follow the same two-step pattern:

```typescript
// Pattern A: user-only message
const response = await llmClient.sendMessage(
  [{ role: "user", content: prompt }],
  { max_tokens: 2048, temperature: 0 }
);

// Pattern B: with system prompt
const response = await llmClient.sendMessage(
  [{ role: "user", content: prompt }],
  { system: "You are ...", max_tokens: 512, temperature: 0 }
);

// Response parsing
const raw = JSON.parse(extractJSON(response.content));
const parsed = SomeZodSchema.parse(raw);
// or:
const parsed = llmClient.parseJSON(response.content, SomeZodSchema);
```

**Key callers for Phase B wiring**:
- `src/observation/observation-llm.ts::observeWithLLM()` — no system prompt currently
- `src/execution/task-generation.ts::generateTask()` — uses system prompt, passes `knowledgeContext` param but NOT lessons/reflections
- `src/execution/task-verifier.ts` — uses system prompt for revert
- `src/strategy/strategy-manager-base.ts` — uses system prompt

---

## 10. VectorIndex

**File**: `src/knowledge/vector-index.ts`

```typescript
export class VectorIndex {
  static async create(indexPath: string, embeddingClient: IEmbeddingClient): Promise<VectorIndex>

  async add(id: string, text: string, metadata?: Record<string, unknown>): Promise<EmbeddingEntry>

  async search(query: string, topK = 5, threshold = 0.0): Promise<VectorSearchResult[]>
  // VectorSearchResult = { id: string; text: string; similarity: number; metadata: Record<string, unknown> }

  searchByVector(queryVector: number[], topK = 5, threshold = 0.0): VectorSearchResult[]

  async searchMetadata(query: string, topK = 20, threshold = 0.0): Promise<Array<{
    id: string; similarity: number; metadata: Record<string, unknown>
  }>>

  async remove(id: string): Promise<boolean>
  get size(): number
  getEntry(id: string): EmbeddingEntry | undefined
  getEntryById(id: string): EmbeddingEntry | undefined
  async clear(): Promise<void>
}
```

**Note**: VectorIndex uses cosine similarity (hand-implemented in `embedding-client.ts`). Metadata field `is_lesson: true` is used to identify lesson entries in search results.

---

## 11. Design Doc Target: PromptGateway Interface

**File**: `docs/design/prompt-context-architecture.md` (lines 155–178)

The design doc specifies the target interface to implement:

```typescript
type ContextPurpose =
  | "observation"
  | "task_generation"
  | "verification"
  | "strategy_generation"
  | "goal_decomposition";

interface PromptGatewayInput<T> {
  purpose: ContextPurpose;
  goalId: string;
  dimensionName?: string;
  additionalContext?: Record<string, string>;
  responseSchema: z.ZodSchema<T>;
}

interface PromptGateway {
  execute<T>(input: PromptGatewayInput<T>): Promise<T>;
}

interface AssembledContext {
  systemPrompt: string;
  contextBlock: string;  // XML-tagged
  totalTokensUsed: number;
}
```

**Target file structure**:
```
src/prompt/
├── gateway.ts              # PromptGateway (thin orchestrator)
├── context-assembler.ts    # Memory → XML blocks
├── slot-definitions.ts     # Purpose → slot mapping
├── formatters.ts           # XML formatters, token truncation
├── purposes/
│   ├── observation.ts
│   ├── task-generation.ts
│   ├── verification.ts
│   ├── strategy.ts
│   └── goal-decomposition.ts
└── index.ts
```

---

## 12. Context Slot Matrix (from design doc §5.2)

| Slot | Observation | Task Gen | Verification | Strategy | Goal Decomp |
|------|:-----------:|:--------:|:------------:|:--------:|:-----------:|
| Goal definition (core) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Current state (core) | ✓ | ✓ | ✓ | ✓ | - |
| Dimension history (recall) | ✓ | - | - | - | - |
| Recent task results (recall) | - | ✓ | ✓ | - | - |
| Reflection notes (recall) | - | ✓ | - | - | - |
| Lessons (archival/cold) | - | ✓ | - | ✓ | - |
| Knowledge (archival) | - | ✓ | ✓ | ✓ | ✓ |
| Strategy templates (archival) | - | - | - | ✓ | - |
| Workspace state (recall) | ✓ | ✓ | - | - | - |
| Failure context (recall) | - | ✓ | - | - | - |

---

## Gaps / Caveats

1. **`computeRelevanceScore` does not exist** — the design doc references it but the actual function is `relevanceScore()` in `memory-selection.ts`. **Confirmed gap in design doc naming.**

2. **`llmClassifyTier` uses non-standard interface** — takes `{ generateStructured: ... }` not `ILLMClient`. ContextAssembler should NOT call it directly unless wrapped. Design doc flags this as a Minor Gap.

3. **`StrategyTemplateRegistry.searchSimilar()`** — the registry is in `src/strategy/strategy-template-registry.ts`. Workers should read this file to understand the search API before implementing the strategy purposes slot.

4. **`workspace-context.ts` vs `context-provider.ts`** — two files exist. `context-provider.ts` is newer and has tier support. Design doc says `workspace-context.ts` gets absorbed into ContextAssembler. Use `buildWorkspaceContextItems()` from `context-provider.ts`.

5. **No `IKnowledgeManager` interface** — `KnowledgeManager` is a concrete class at `src/knowledge/knowledge-manager.ts`. Workers will need to check its `loadKnowledge(goalId, tags?)` and `getRelevantKnowledge(goalId)` signatures directly.
