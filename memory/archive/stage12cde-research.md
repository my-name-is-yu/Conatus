# Stage 12 Part C/D/E Research

**Status**: 調査完了
**調査対象**: Part C (12.1 埋め込み基盤), Part D (12.2 知識 Phase 2 + 12.4 満足化マッピング), Part E (12.7 記憶ライフサイクル Phase 2 + 12.3 好奇心 Phase 2)

---

## Part C: 12.1 埋め込み基盤

### 既存ファイル: src/llm-client.ts (223行)

**現状**:
- `ILLMClient` インターフェース — `sendMessage()` + `parseJSON()` のみ。`embed()` メソッドは存在しない (**Confirmed**)
- `LLMClient` クラス — Anthropic SDK ラッパー、constructor で `apiKey` を受け取る
- `MockLLMClient` クラス — テスト用、`responses: string[]` をコンストラクタで受け取る
- `OllamaLLMClient` — `src/ollama-client.ts` に別ファイルとして存在（`src/index.ts` L28 で export確認）

**Part C での変更点**:
- `ILLMClient` インターフェースに `embed(text: string): Promise<number[]>` を追加する必要があるが、**注意**: ILLMClient を変更するとすべての既存実装（LLMClient, MockLLMClient, OllamaLLMClient）を修正しなければならない
- 代替案: 別インターフェース `IEmbeddingClient` として切り出し、LLMClient がオプションで実装する
- **推奨**: IEmbeddingClient を独立インターフェースとして定義し、ILLMClient には追加しない（後方互換を保つ）

**挿入点**:
- `LLMClient` クラスに `embed()` を追加する場合は L162 (`// ─── MockLLMClient ───`) の直前
- `MockLLMClient` にも `embed()` のモック実装が必要（固定次元ベクトルを返す）

### 既存ファイル: src/index.ts (89行)

**現状の export パターン**:
```typescript
export { SomeClass } from "./some-module.js";
export type { SomeInterface } from "./some-module.js";
```
- L28: `export { OllamaLLMClient } from "./ollama-client.js"` — 既存パターンで新クラス追加可能
- Part C 追加分 (L69 GoalDependencyGraph の後):
  ```typescript
  export { EmbeddingClient } from "./embedding-client.js";
  export { VectorIndex } from "./vector-index.js";
  export type { IEmbeddingClient, EmbeddingEntry, VectorSearchResult, EmbeddingConfig } from "./types/embedding.js";
  ```

### 既存ファイル: src/state-manager.ts (379行)

**ファイルレイアウト（VectorIndex の永続化参考用）**:
```
<base>/goals/<goal_id>/goal.json
<base>/goal-trees/<root_id>.json
<base>/events/
<base>/reports/
```
- Atomic write パターン: `atomicWrite(filePath, data)` = tmp ファイル書き込み → rename
- `writeRaw(relativePath, data)` — ベースディレクトリ相対で任意パスに書き込み（`ensureDir` 付き）
- `readRaw(relativePath)` — 対応する読み込み

**VectorIndex の永続化パス**: `~/.motiva/embeddings/<index_name>.json`
→ `StateManager.writeRaw("embeddings/<name>.json", data)` パターンが使える
→ ただし VectorIndex は StateManager に依存させず、直接 fs を使うか、baseDir を受け取る設計が適切

### 新規ファイル設計

#### src/types/embedding.ts

```typescript
import { z } from "zod";

export const EmbeddingConfigSchema = z.object({
  model: z.string().default("text-embedding-3-small"),  // OpenAI
  // or "voyage-3" for Anthropic, "nomic-embed-text" for Ollama
  dimensions: z.number().int().positive().default(1536),
  provider: z.enum(["openai", "ollama", "mock"]).default("mock"),
  base_url: z.string().optional(),  // Ollama の場合 http://localhost:11434
});
export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;

export const EmbeddingEntrySchema = z.object({
  id: z.string(),           // UUID
  text: z.string(),         // 元テキスト
  vector: z.array(z.number()),
  model: z.string(),
  created_at: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type EmbeddingEntry = z.infer<typeof EmbeddingEntrySchema>;

export const VectorSearchResultSchema = z.object({
  id: z.string(),
  text: z.string(),
  similarity: z.number().min(-1).max(1),  // cosine similarity
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type VectorSearchResult = z.infer<typeof VectorSearchResultSchema>;
```

#### src/embedding-client.ts

```typescript
export interface IEmbeddingClient {
  embed(text: string): Promise<number[]>;
  batchEmbed(texts: string[]): Promise<number[][]>;
  cosineSimilarity(a: number[], b: number[]): number;
}

// OpenAI実装（text-embedding-3-small）
export class OpenAIEmbeddingClient implements IEmbeddingClient { ... }

// Ollamaローカル実装（nomic-embed-text）
export class OllamaEmbeddingClient implements IEmbeddingClient { ... }

// テスト用モック（決定論的固定ベクトル）
export class MockEmbeddingClient implements IEmbeddingClient {
  // テキストのハッシュから固定次元ベクトルを生成
}
```

**技術判断（Part C 着手前に決定が必要）**:
1. **埋め込みモデル**: Anthropic は現時点で text embeddings API を提供していない（Anthropic SDK に embeddings エンドポイントなし）。**OpenAI text-embedding-3-small** または **Ollama nomic-embed-text** が現実的。MVP = Ollama（依存ゼロ、OllamaLLMClient が既存）
2. **VectorIndex 実装**: MVP = 手実装 cosine similarity（外部依存なし）。エントリ数 < 10,000 では十分高速

#### src/vector-index.ts

```typescript
export class VectorIndex {
  constructor(
    private readonly indexPath: string,  // ~/.motiva/embeddings/<name>.json
    private readonly embeddingClient: IEmbeddingClient
  ) {}

  // エントリ追加
  async add(id: string, text: string, metadata?: Record<string, unknown>): Promise<EmbeddingEntry>

  // テキストで類似検索
  async search(query: string, topK: number = 5, threshold?: number): Promise<VectorSearchResult[]>

  // ベクトルで直接検索
  searchByVector(queryVector: number[], topK: number = 5, threshold?: number): VectorSearchResult[]

  // ID で削除
  remove(id: string): boolean

  // 永続化（atomic write）
  private save(): void
  private load(): void

  // エントリ数
  get size(): number
}
```

**Gotcha**: VectorIndex は `indexPath` ベースで直接 fs を使う。StateManager 経由にすると DI が複雑になりすぎる。

---

## Part D: 12.2 知識 Phase 2 + 12.4 満足化マッピング

### 既存ファイル: src/knowledge-manager.ts (404行)

**クラス**: `KnowledgeManager`

**コンストラクタ DI**:
```typescript
constructor(stateManager: StateManager, llmClient: ILLMClient)
```

**現在の検索 API**:
```typescript
// タグ完全一致（All tags must match）
async loadKnowledge(goalId: string, tags?: string[]): Promise<KnowledgeEntry[]>

// dimension_name をタグとして完全一致検索
async getRelevantKnowledge(goalId: string, dimensionName: string): Promise<KnowledgeEntry[]>
```

**矛盾検知**:
```typescript
// 同じタグを持つ既存エントリとLLM比較
async checkContradiction(goalId: string, newEntry: KnowledgeEntry): Promise<ContradictionResult>
```

**永続化パス**: `goals/<goal_id>/domain_knowledge.json`（ゴール別JSON）

**Part D での変更点**:
1. コンストラクタに `IEmbeddingClient` と `VectorIndex` を追加（オプション）
   ```typescript
   constructor(
     stateManager: StateManager,
     llmClient: ILLMClient,
     vectorIndex?: VectorIndex  // Phase 2オプション
   )
   ```
2. `loadKnowledge()` にベクトル検索オーバーロード追加:
   ```typescript
   async searchKnowledge(query: string, topK?: number): Promise<KnowledgeEntry[]>  // 新規
   ```
3. `checkContradiction()` を埋め込み類似度ベースに強化
4. ゴール横断検索: `searchAcrossGoals(query: string, topK?: number)`（全ゴールのVectorIndex を横断）

**挿入点**: L373 (`getRelevantKnowledge` の直後) に新メソッド群を追加

### 既存ファイル: src/types/knowledge.ts (73行)

**現状の `KnowledgeEntrySchema`** (L23-34):
```typescript
export const KnowledgeEntrySchema = z.object({
  entry_id: z.string(),
  question: z.string(),
  answer: z.string(),
  sources: z.array(SourceSchema),
  confidence: z.number().min(0).max(1),
  acquired_at: z.string(),
  acquisition_task_id: z.string(),
  superseded_by: z.string().nullable().default(null),
  tags: z.array(z.string()),
  // embedding_id は未存在 ← 追加が必要
});
```

**追加フィールド**:
```typescript
embedding_id: z.string().nullable().default(null),  // VectorIndex内のID
```

**新規型（グラフエッジ用）**:
```typescript
export const KnowledgeRelationTypeEnum = z.enum([
  "supports",      // 支持関係
  "contradicts",   // 矛盾
  "refines",       // 精緻化
  "depends_on",    // 依存
]);

export const KnowledgeEdgeSchema = z.object({
  from_id: z.string(),
  to_id: z.string(),
  relation: KnowledgeRelationTypeEnum,
  confidence: z.number().min(0).max(1),
  created_at: z.string(),
});
```

### 新規ファイル: src/knowledge-graph.ts

```typescript
export class KnowledgeGraph {
  constructor(
    private readonly stateManager: StateManager,
    private readonly graphPath: string = "knowledge-graph.json"  // writeRaw相対パス
  )

  // ノード（KnowledgeEntryをノードとして扱う）
  addNode(entry: KnowledgeEntry): void
  removeNode(entryId: string): void

  // エッジ CRUD
  addEdge(edge: KnowledgeEdge): void
  removeEdge(fromId: string, toId: string): void
  getEdges(entryId: string): KnowledgeEdge[]

  // 整合性チェック
  detectCycles(): string[][]
  checkConsistency(entries: KnowledgeEntry[]): ContradictionResult[]

  // 永続化
  private save(): void
  load(): void
}
```

**永続化パス**: `~/.motiva/knowledge-graph.json`（ゴール横断のグローバルグラフ）

### 既存ファイル: src/session-manager.ts (394行)

**現在の知識注入 API**:
```typescript
// 非同期でなくタグ完全一致の知識を挿入（L291-318）
injectKnowledgeContext(slots: ContextSlot[], entries: KnowledgeEntry[]): ContextSlot[]
```

**Part D での変更点**:
- `injectKnowledgeContext()` のシグネチャは変えない（後方互換）
- 新規に `injectSemanticKnowledgeContext()` を追加（VectorIndex 経由）:
  ```typescript
  async injectSemanticKnowledgeContext(
    slots: ContextSlot[],
    query: string,
    knowledgeManager: KnowledgeManager,
    goalId: string,
    topK?: number
  ): Promise<ContextSlot[]>
  ```
- `buildTaskExecutionContext()` のシグネチャは変えない（コンテキストスロット構造自体は不変）

**挿入点**: L318 (`injectKnowledgeContext` 末尾) の直後

### 既存ファイル: src/satisficing-judge.ts (549行)

**クラス**: `SatisficingJudge`

**コンストラクタ DI**:
```typescript
constructor(stateManager: StateManager)
```

**現在の公開 API**:
- `isDimensionSatisfied(dim: Dimension): DimensionSatisfaction`
- `isGoalComplete(goal: Goal): CompletionJudgment`
- `applyProgressCeiling(actualProgress, confidence): number`
- `selectDimensionsForIteration(dimensions, driveScores, constraints?): string[]`
- `detectThresholdAdjustmentNeeded(goal, failureCounts): ThresholdAdjustmentProposal[]`
- `propagateSubgoalCompletion(subgoalId, parentGoalId, subgoalDimensions?): void`
- `aggregateValues` (純粋関数、export済み)

**Part D での変更点（12.4 満足化マッピング）**:
1. コンストラクタに `IEmbeddingClient` を追加（オプション）:
   ```typescript
   constructor(stateManager: StateManager, embeddingClient?: IEmbeddingClient)
   ```
2. `proposeDimensionMapping()` メソッドを追加（L432 `aggregateValues` の直前に挿入）:
   ```typescript
   async proposeDimensionMapping(
     subgoalDimensions: Dimension[],
     parentGoalDimensions: Dimension[]
   ): Promise<MappingProposal[]>
   ```

**注意**: `propagateSubgoalCompletion()` は L294-432 に実装済み。`dimension_mapping` フィールドも既存で対応済み。`proposeDimensionMapping()` は「次元マッピングの自動提案」機能のみ追加。

### 既存ファイル: src/types/satisficing.ts (40行)

**現状** — 4型のみ:
- `CompletionJudgmentSchema`
- `DimensionSatisfactionSchema`
- `IterationConstraintsSchema`
- `ThresholdAdjustmentProposalSchema`

**追加型**:
```typescript
export const MappingProposalSchema = z.object({
  subgoal_dimension: z.string(),       // サブゴール次元名
  parent_dimension: z.string(),        // 提案する親ゴール次元名
  similarity_score: z.number().min(0).max(1),  // cosine similarity
  suggested_aggregation: z.enum(["min", "avg", "max", "all_required"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),               // なぜこのマッピングが適切か
});
export type MappingProposal = z.infer<typeof MappingProposalSchema>;
```

### 既存ファイル: src/goal-negotiator.ts (938行)

**クラス**: `GoalNegotiator`

**コンストラクタ DI**:
```typescript
constructor(
  stateManager: StateManager,
  llmClient: ILLMClient,
  ethicsGate: EthicsGate,
  observationEngine: ObservationEngine,
  characterConfig?: CharacterConfig
)
```

**Part D での変更点（自動マッピング提案の活用）**:
- `decompose()` メソッド（L474-550）でサブゴール生成後に `SatisficingJudge.proposeDimensionMapping()` を呼ぶ
- コンストラクタに `SatisficingJudge` を追加（オプション）:
  ```typescript
  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    ethicsGate: EthicsGate,
    observationEngine: ObservationEngine,
    characterConfig?: CharacterConfig,
    satisficingJudge?: SatisficingJudge  // Phase 2: 自動マッピング提案用
  )
  ```
- `decompose()` L541（`this.stateManager.saveGoal(subgoal)` の後）に挿入

---

## Part E: 12.7 記憶ライフサイクル Phase 2 + 12.3 好奇心 Phase 2

### 既存ファイル: src/memory-lifecycle.ts (~1400行)

**クラス**: `MemoryLifecycleManager`

**コンストラクタ DI**:
```typescript
constructor(
  baseDir: string,           // ~/.motiva/
  llmClient: ILLMClient,
  config?: Partial<RetentionConfig>
)
```

**現在の公開 API**:
```typescript
initializeDirectories(): void
recordToShortTerm(goalId, dataType, data, options?): ShortTermEntry
async compressToLongTerm(goalId, dataType, loopNumber): Promise<CompressionResult>
selectForWorkingMemory(goalId, dimensions, tags, maxEntries?): { shortTerm, lessons }
async applyRetentionPolicy(goalId): Promise<CompressionResult[]>
async onGoalClose(goalId): Promise<void>
getStatistics(goalId): StatisticalSummary | null
async runGarbageCollection(): Promise<void>
```

**Working Memory 選択の現状** (L326-380):
- タグ完全一致 + 時間降順ソート（MVP）
- 埋め込みなし
- `selectForWorkingMemory()` が同期メソッド

**Part E での変更点（12.7）**:
1. コンストラクタに `IEmbeddingClient` + `VectorIndex` を追加（オプション）:
   ```typescript
   constructor(
     baseDir: string,
     llmClient: ILLMClient,
     config?: Partial<RetentionConfig>,
     embeddingClient?: IEmbeddingClient,
     vectorIndex?: VectorIndex
   )
   ```
2. `selectForWorkingMemory()` を非同期化（`async`）し、埋め込みが利用可能な場合はVectorIndex経由に切り替え:
   ```typescript
   async selectForWorkingMemory(
     goalId: string,
     dimensions: string[],
     tags: string[],
     maxEntries?: number
   ): Promise<{ shortTerm: ShortTermEntry[]; lessons: LessonEntry[] }>
   ```
   **重大な後方互換問題**: 現在は同期メソッド。非同期化すると呼び出し元（core-loop.ts等）も変更が必要。対応策: `selectForWorkingMemorySync()`を残し、新規`selectForWorkingMemory()`を非同期にするか、embeddings なしの場合は同期パスを維持。
3. Drive-based 管理メソッドを追加:
   ```typescript
   // 不満駆動: 圧縮を最大2倍遅延
   getCompressionDelay(goalId: string, driveScores: DriveScore[]): number

   // 締切ボーナス: Working Memory 優先度 + 最大30%
   getDeadlineBonus(goalId: string, driveScores: DriveScore[]): number

   // SatisficingJudge 判定フック: 完了次元を早期圧縮候補にマーク
   markForEarlyCompression(goalId: string, satisfiedDimensions: string[]): void
   ```
4. `recordToShortTerm()` の拡張: `embedding_id` フィールドを付与（`ShortTermEntry` への追加が必要）

### 既存ファイル: src/types/memory-lifecycle.ts (151行)

**Part E での変更点**:
1. `ShortTermEntrySchema` に `embedding_id` フィールドを追加（L38 直後）:
   ```typescript
   embedding_id: z.string().nullable().default(null),
   ```
2. `MemoryIndexEntrySchema` に `embedding_id` 追加（L127直後）:
   ```typescript
   embedding_id: z.string().nullable().default(null),
   ```
3. 新型追加（L151 末尾）:
   ```typescript
   export const RelevanceScoreSchema = z.object({
     entry_id: z.string(),
     goal_id: z.string(),
     dimensions: z.array(z.string()),
     semantic_score: z.number().min(0).max(1),  // embedding similarity
     recency_score: z.number().min(0).max(1),
     drive_bonus: z.number().min(0).max(0.3),   // deadline bonus max 30%
     combined_score: z.number().min(0),
   });
   export type RelevanceScore = z.infer<typeof RelevanceScoreSchema>;

   export const CompressionPolicySchema = z.object({
     goal_id: z.string(),
     dimension: z.string(),
     policy: z.enum([
       "normal",
       "delayed",           // 不満駆動: 最大2x遅延
       "early_compression", // 満足化判定: 早期圧縮
       "deadline_priority", // 締切駆動: Working Memory 優先引き出し
     ]),
     delay_factor: z.number().default(1.0),  // 1.0=通常, 2.0=2倍遅延
     updated_at: z.string(),
   });
   export type CompressionPolicy = z.infer<typeof CompressionPolicySchema>;
   ```

### 既存ファイル: src/drive-scorer.ts (311行)

**現状**: 純粋関数のみ（クラスなし）。以下がエクスポート済み:
```typescript
export function scoreDissatisfaction(normalizedWeightedGap, timeSinceLastAttemptHours, config?): DissatisfactionScore
export function scoreDeadline(normalizedWeightedGap, timeRemainingHours, config?): DeadlineScore
export function scoreOpportunity(opportunityValue, timeSinceDetectedHours, config?): OpportunityScore
export function computeOpportunityValue(downstreamImpact, externalBonus, timingBonus): number
export function combineDriveScores(dissatisfaction, deadline, opportunity, config?): DriveScore
export function scoreAllDimensions(gapVector, context, config?): DriveScore[]
export function rankDimensions(scores): DriveScore[]
```

**Part E での変更点**:
- `MemoryLifecycleManager` が DriveScore を受け取るために **DriveScorer の変更は不要**
- 既存の `DriveScore` 型を `src/types/drive.ts` からインポートして `MemoryLifecycleManager` で参照するだけ
- ただし `DriveScore` 型の `dominant_drive` フィールドを参照するためには `src/types/drive.ts` を直接インポートする
- **変更なし** (**Confirmed**)

### 既存ファイル: src/satisficing-judge.ts (Part E での追加)

**Part E での変更点（12.7 フック）**:
- `isGoalComplete()` / `isDimensionSatisfied()` に完了判定後のフック追加
- ただし `SatisficingJudge` に `MemoryLifecycleManager` を DI するのは循環依存リスクあり
  - `SatisficingJudge` → `MemoryLifecycleManager` → （nothing, OK）
  - `MemoryLifecycleManager` → `SatisficingJudge` はない → **循環なし、DI OK**
- 設計方針: `onSatisficingJudgment` コールバック（オプション）をコンストラクタで渡す
  ```typescript
  constructor(
    stateManager: StateManager,
    embeddingClient?: IEmbeddingClient,
    onSatisficingJudgment?: (goalId: string, satisfiedDimensions: string[]) => void
  )
  ```
- 挿入点: `isGoalComplete()` L166 (`return { is_complete, ... }` の直前)

### 既存ファイル: src/curiosity-engine.ts (824行)

**クラス**: `CuriosityEngine`

**コンストラクタ DI** (`CuriosityEngineDeps` インターフェース):
```typescript
interface CuriosityEngineDeps {
  stateManager: StateManager;
  llmClient: ILLMClient;
  ethicsGate: EthicsGate;
  satisficingJudge: SatisficingJudge;
  stallDetector: StallDetector;
  observationEngine: ObservationEngine;
  driveSystem: DriveSystem;
  config?: Partial<CuriosityConfig>;
}
```

**Part E での変更点（12.3 好奇心 Phase 2）**:
1. `CuriosityEngineDeps` に `vectorIndex?: VectorIndex` を追加
2. `detectCrossGoalTransfer()` は現在 **存在しない**（`checkRepeatedFailures()` L224 が最も近い）。`checkTaskQueueEmpty()`, `checkUnexpectedObservation()`, `checkRepeatedFailures()`, `checkUndefinedProblems()`, `checkPeriodicExploration()` の5つのトリガーチェックが実装済み。
   - クロスゴール転移検出はトリガーではなく **プロポーザル生成の内部ロジック** として位置づける
   - `generateProposals()` L439 内の LLM 呼び出しを、埋め込みベースの候補フィルタリングに置き換え
3. 盲点検出 (`detectBlindSpots`) は現在独立メソッドとして存在しない。`checkUndefinedProblems()` L260 が近い実装。
   - Phase 2: `checkUndefinedProblems()` を埋め込みベースに強化（LLM ヒューリスティック → 埋め込み類似度）

**`detection_method` の現状** (`src/types/curiosity.ts` L52-58):
```typescript
detection_method: z.enum([
  "observation_log",
  "stall_pattern",
  "cross_goal_transfer",
  "llm_heuristic",
  "periodic_review",
]),
```
→ `"embedding_similarity"` を追加する（L57 の `"periodic_review"` の後）

**注意**: `detection_method` フィールドは `CuriosityProposalSchema` の `proposed_goal` ネストオブジェクト内 (L52-58)。`LLMProposalItemSchema` (L59-67, curiosity-engine.ts 内のローカルスキーマ) にも同じ enum が定義されており、**両方を更新**する必要がある。

### 既存ファイル: src/types/curiosity.ts (107行)

**Part E での変更点**:
- L57 (`"periodic_review"` の後): `"embedding_similarity"` を追加
- `CuriosityProposalSchema.proposed_goal.detection_method` の enum も更新（同じファイル内 L52-58）

---

## 全体的なゴッチャ・設計注意点

### 1. ILLMClient の変更は避ける
`embed()` を `ILLMClient` に追加すると `LLMClient`, `MockLLMClient`, `OllamaLLMClient` の3クラスすべてへの変更が必要。`IEmbeddingClient` を独立インターフェースとして設計し、オプションDIで渡す方が安全。

### 2. selectForWorkingMemory の非同期化問題
`MemoryLifecycleManager.selectForWorkingMemory()` は現在同期メソッド。非同期化すると呼び出し元（`core-loop.ts` 等）も影響を受ける。対策: 埋め込みなしの場合は同期パスを維持し、`embeddingClient` が注入された場合のみ非同期パスに切り替える（条件分岐）。

### 3. KnowledgeManager のゴール別 → ゴール横断の移行
現状: `goals/<goal_id>/domain_knowledge.json`（ゴール別JSON）。Phase 2 では横断検索を追加するが、**既存ファイル構造を壊さない**。VectorIndex を別途 `knowledge-vectors/global.json` として管理し、エントリには `goal_id` を metadata として持たせる。

### 4. detection_method の二重定義
`types/curiosity.ts` と `curiosity-engine.ts` 内のローカルスキーマ `LLMProposalItemSchema` に同じ enum が2箇所存在。Part E では両方に `"embedding_similarity"` を追加する必要あり（L57 of curiosity.ts, and L59-67 of curiosity-engine.ts）。

### 5. VectorIndex の初期化
`VectorIndex` がファイルを直接扱う場合、`~/.motiva/embeddings/` ディレクトリを事前に作成する必要がある。`StateManager.ensureDirectories()` に `embeddings` ディレクトリを追加するか、`VectorIndex` のコンストラクタ内で `fs.mkdirSync()` を実行する。

### 6. 埋め込みモデル選定（Part C 着手前に決定必要）
- Anthropic: embeddings API なし（SDK に存在しない）
- OpenAI: `text-embedding-3-small` (1536次元, $0.02/1M tokens)
- Ollama: `nomic-embed-text` (768次元, ローカル, 無料)
- **推奨**: Ollama MVP（既存の OllamaLLMClient との整合性、ローカルテスト容易）、OpenAI を本番オプションとして提供

---

## テストファイルパターン参照

Part A 研究 (`memory/stage12a-research.md`) から確認済み:
- `makeGoal(overrides)` ファクトリ関数パターン（全フィールド明示列挙）
- `fs.mkdtempSync()` + `beforeEach/afterEach` クリーンアップ
- `describe` → `it` 入れ子でグループ化

**新規テストファイル用パターン**:
```typescript
// tests/embedding-client.test.ts
import { MockEmbeddingClient } from "../src/embedding-client.js";
// MockEmbeddingClient: テキストから決定論的ベクトルを生成（ハッシュベース）

// tests/vector-index.test.ts
let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motiva-test-")); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true }); });
const index = new VectorIndex(path.join(tmpDir, "test.json"), new MockEmbeddingClient());

// tests/knowledge-graph.test.ts
// 同様の tmpDir パターン
```

---

## ファイル別変更サマリー

| ファイル | 行数 | 変更種別 | 変更規模 |
|---------|------|---------|---------|
| `src/types/embedding.ts` | 新規 | 新規作成 | ~50行 |
| `src/embedding-client.ts` | 新規 | 新規作成 | ~100行 |
| `src/vector-index.ts` | 新規 | 新規作成 | ~150行 |
| `src/knowledge-graph.ts` | 新規 | 新規作成 | ~150行 |
| `src/types/knowledge.ts` | 73行 | `embedding_id` + エッジ型追加 | +25行 |
| `src/types/satisficing.ts` | 40行 | `MappingProposal` 型追加 | +15行 |
| `src/types/memory-lifecycle.ts` | 151行 | `RelevanceScore`, `CompressionPolicy`, `embedding_id` 追加 | +30行 |
| `src/types/curiosity.ts` | 107行 | `"embedding_similarity"` 追加 | +1行 (2箇所) |
| `src/llm-client.ts` | 223行 | 変更なし（ILLMClient非変更方針） | 0 |
| `src/index.ts` | 89行 | 新クラスの export 追加 | +5行 |
| `src/state-manager.ts` | 379行 | embeddings ディレクトリ追加 | +1行 |
| `src/knowledge-manager.ts` | 404行 | VectorIndex DI + 新検索メソッド | +80行 |
| `src/session-manager.ts` | 394行 | セマンティック知識注入メソッド追加 | +30行 |
| `src/satisficing-judge.ts` | 549行 | `proposeDimensionMapping()` + フック追加 | +60行 |
| `src/goal-negotiator.ts` | 938行 | `SatisficingJudge` DI + `decompose()` 内追加 | +15行 |
| `src/memory-lifecycle.ts` | ~1400行 | VectorIndex DI + Drive-based 管理 + WM選択拡張 | +120行 |
| `src/drive-scorer.ts` | 311行 | 変更なし | 0 |
| `src/curiosity-engine.ts` | 824行 | VectorIndex DI + `checkUndefinedProblems()` 強化 + `LLMProposalItemSchema` 更新 | +50行 |

---

## ギャップ（未確定）

- **埋め込みモデル選定**: Ollama `nomic-embed-text` vs OpenAI `text-embedding-3-small` — 技術スパイク必要 (**Uncertain**)
- **VectorIndex ライブラリ**: 手実装 cosine similarity で十分か、`@xenova/transformers` 等のライブラリが必要か — エントリ数10,000未満なら手実装で十分 (**Likely**)
- **selectForWorkingMemory の非同期化影響範囲**: core-loop.ts の呼び出し箇所を確認する必要あり (**Uncertain**)
- **Anthropic embeddings API 追加**: Anthropic が将来 embeddings API を追加した場合に切り替えやすいか — IEmbeddingClient 抽象化で対応済み (**Confirmed**, 対応済み)
