# Stage 12 実装計画: 意味的埋め込みと知識進化

**ステータス**: 計画策定済み、未着手
**前提**: Stage 1-11 完了（1749テスト、35テストファイル）
**詳細リサーチ**: `memory/stage12-research.md`

---

## パート構成（5パート、順次実装）

依存グラフに基づき、独立サブシステム → 埋め込み基盤 → 埋め込み依存サブシステムの順で実装する。

```
Part A: 12.5 状態ベクトル Phase 2    ← 独立、即着手可
Part B: 12.6 セッション・コンテキスト Phase 2  ← 独立、Aと並行可
Part C: 12.1 埋め込み基盤            ← D/Eの前提
Part D: 12.2 知識 + 12.4 満足化マッピング  ← 12.1依存
Part E: 12.7 記憶ライフサイクル + 12.3 好奇心  ← 12.1依存、12.2があると精度向上
```

---

## Part A: 12.5 状態ベクトル Phase 2

**スコープ**: マイルストーンペース評価、集約マッピングの型反映
**サイズ**: Multi-file（3-4ファイル）
**埋め込み依存**: なし

### 実装内容
1. `src/types/state.ts` — `Dimension` に `dimension_mapping` フィールド追加、`Milestone` 型（target_date, pace_snapshot）追加
2. `src/types/goal.ts` — ゴールツリーノードの `type` に `"milestone"` 追加
3. `src/state-manager.ts` — マイルストーン追跡、ペース評価ロジック（on_track/at_risk/behind）、リスケジュール提案
4. `src/core-loop.ts` — マイルストーン期限チェックの組み込み（最小限）

### テスト
- `tests/state-manager.test.ts` — ペース評価のユニットテスト
- マイルストーン到達・超過・リスケジュールのシナリオ

### 注意点
- Stage 11Bで `satisficing-judge.ts` に集約マッピング全種は追加済み。`types/state.ts` 側のデータ構造反映が対象
- CoreLoopへの組み込みは最小限に。StateManager内で完結させる

---

## Part B: 12.6 セッション・コンテキスト Phase 2

**スコープ**: 動的バジェット選択、ゴール依存グラフ
**サイズ**: Multi-file（4-5ファイル）
**埋め込み依存**: なし（LLM呼び出しのみ）

### 実装内容
1. `src/types/dependency.ts`（新規）— DependencyEdge, DependencyGraph, DependencyType Zodスキーマ
2. `src/goal-dependency-graph.ts`（新規）— GoalDependencyGraph（DAG管理、循環検出、エッジCRUD、スケジューリング影響計算）
3. `src/types/session.ts` — コンテキストバジェット設定型追加
4. `src/session-manager.ts` — 固定top-4 → トークンバジェットベースの動的コンテキスト選択
5. `src/core-loop.ts` — 依存グラフに基づくスケジューリング制御（boost_drive_score, skip_task_generation）

### テスト
- `tests/goal-dependency-graph.test.ts`（新規）— DAG操作、循環検出、スケジューリング影響
- `tests/session-manager.test.ts` — 動的バジェット選択のテスト追加

### 注意点
- LLM自動検出（auto_detect_dependencies）はMockLLMClientでテスト
- DAGの永続化は `~/.motiva/dependency-graph.json`

---

## Part C: 12.1 埋め込み基盤

**スコープ**: EmbeddingClient + VectorIndex + 型定義
**サイズ**: Multi-file（3-4ファイル新規 + 2既存変更）
**埋め込み依存**: これ自体が基盤

### 実装内容
1. `src/types/embedding.ts`（新規）— EmbeddingEntry, VectorSearchResult, EmbeddingConfig Zodスキーマ
2. `src/embedding-client.ts`（新規）— IEmbeddingClient インターフェース + 実装（embed, batch_embed, cosine_similarity）
3. `src/vector-index.ts`（新規）— VectorIndex（追加・検索・永続化、`~/.motiva/embeddings/`）
4. `src/llm-client.ts` — `embed()` メソッド追加（IEmbeddingClient経由）
5. `src/index.ts` — 新クラスエクスポート

### 技術判断（着手前に決定）
- **埋め込みモデル**: Anthropic vs OpenAI → IEmbeddingClient で抽象化し両対応
- **ベクトル検索**: 手実装cosine similarity vs ライブラリ → MVP=手実装（依存ゼロ）、必要に応じてライブラリ移行
- **Ollama対応**: ローカルLLM同様、Ollamaの埋め込みAPIにも対応するか

### テスト
- `tests/embedding-client.test.ts`（新規）— embed, cosine_similarity, batch_embed
- `tests/vector-index.test.ts`（新規）— CRUD、検索精度、永続化

---

## Part D: 12.2 知識 Phase 2 + 12.4 満足化マッピング

**スコープ**: ゴール横断ナレッジベース + 知識グラフ + 意味的マッピング
**サイズ**: Multi-file（5-6ファイル）
**埋め込み依存**: あり（Part C完了後）

### 12.2 知識 Phase 2
1. `src/types/knowledge.ts` — `KnowledgeEntry` に `embedding_id` 追加、グラフエッジ型
2. `src/knowledge-graph.ts`（新規）— KnowledgeGraph（概念ノード・関係エッジのCRUD、整合性チェック）
3. `src/knowledge-manager.ts` — タグ完全一致 → VectorIndex経由ベクトル検索、矛盾検知高度化
4. `src/session-manager.ts` — コンテキスト注入の知識検索をベクトル検索に切り替え

### 12.4 満足化マッピング
5. `src/types/satisficing.ts` — `MappingProposal` 型追加
6. `src/satisficing-judge.ts` — `proposeDimensionMapping()` メソッド追加
7. `src/goal-negotiator.ts` — ゴール分解時に自動マッピング提案活用

### テスト
- `tests/knowledge-graph.test.ts`（新規）
- `tests/knowledge-manager.test.ts` — ベクトル検索テスト追加
- `tests/satisficing-judge.test.ts` — マッピング提案テスト追加

---

## Part E: 12.7 記憶ライフサイクル Phase 2 + 12.3 好奇心 Phase 2

**スコープ**: Drive-based記憶管理 + 意味的Working Memory + 好奇心の埋め込みベース化
**サイズ**: Multi-file（5-6ファイル）
**埋め込み依存**: あり（Part C完了後、Part D完了で精度向上）

### 12.7 記憶ライフサイクル Phase 2
1. `src/types/memory-lifecycle.ts` — `RelevanceScore`, `CompressionPolicy` 型、`embedding_id` 追加
2. `src/memory-lifecycle.ts` — Drive-based管理（compression_delay, deadline_bonus, early_compression）、Working Memory選択をVectorIndex経由に
3. `src/drive-scorer.ts` — スコア公開メソッド（記憶管理用）
4. `src/satisficing-judge.ts` — 完了判定フック（on_satisficing_judgment → memory-lifecycle通知）

### 12.3 好奇心 Phase 2
5. `src/types/curiosity.ts` — `detection_method` に `"embedding_similarity"` 追加
6. `src/curiosity-engine.ts` — 転移候補検出・盲点検出を埋め込みベースに書き換え

### テスト
- `tests/memory-lifecycle.test.ts` — Drive-based管理テスト追加
- `tests/curiosity-engine.test.ts` — 埋め込みベース転移・盲点検出テスト追加

---

## 全体見積もり

| Part | ファイル数 | 新規 | 変更 | 依存 |
|------|-----------|------|------|------|
| A    | 4         | 0    | 4    | なし |
| B    | 5         | 2    | 3    | なし |
| C    | 5         | 3    | 2    | なし |
| D    | 7         | 1    | 6    | C    |
| E    | 6         | 0    | 6    | C (+ Dで精度↑) |

**合計**: 新規ファイル6、変更ファイル15（重複あり）、テストファイル新規4-5

---

## 着手前の未確定事項

1. **埋め込みモデル選定** — Part C着手時にスパイク実施
2. **Ollama埋め込み対応** — ローカルLLMテスト用にOllamaのembedding APIも対応するか
3. **12.5マイルストーンの実行経路** — 強制観測がTaskLifecycle経由かObservationEngine直接か
