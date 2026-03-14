# Stage 12 Research: 意味的埋め込みと知識進化

**Status**: 未着手
**Prerequisite**: Stage 10（デーモンモード）完了
**Design docs**: `docs/roadmap.md` Stage 12 section, referenced Phase 2 sections in each design doc
**Vision mapping**: ビジョン要素5「自律的知識獲得（高度化）」

---

## 全体概要

Stage 12 は「意味的埋め込み基盤」を横断的インフラとして導入し、その上に6つのサブシステムの Phase 2 を重ねる構造。12.1（埋め込み基盤）が全サブシステムの前提条件になるため、必ず最初に実装する。

---

## サブシステム詳細

### 12.1 埋め込み基盤

**何をするか**
LLMClient に埋め込みモデル（Anthropic / OpenAI）への呼び出しを追加し、ベクトル生成・類似度計算 API を提供する。ファイルベースのベクトルインデックスを構築する。

**触れる既存ファイル**
- `src/llm-client.ts` — `embed(text: string): Promise<number[]>` メソッドを追加
- `src/types/index.ts` — 新型エクスポート
- `src/index.ts` — 新クラスエクスポート

**新規作成が必要なファイル**
- `src/embedding-client.ts` — EmbeddingClient クラス（embed / cosine_similarity / batch_embed）
- `src/vector-index.ts` — VectorIndex クラス（追加・検索・永続化、`~/.motiva/embeddings/` に保存）
- `src/types/embedding.ts` — EmbeddingEntry, VectorSearchResult, EmbeddingConfig Zod スキーマ

**依存関係**
他の 12.x すべての前提。12.1 なしに 12.2〜12.7 は実装できない。

---

### 12.2 知識獲得 Phase 2

**設計ドキュメント**: `docs/design/knowledge-acquisition.md` §5.4 Phase 2

**何をするか**
- ゴール別 JSON（`~/.motiva/goals/<goal_id>/domain_knowledge.json`）からゴール横断のナレッジベースへ移行
- 埋め込みによるベクトル検索でゴール間の暗黙的知識共有を実現
- 知識グラフ（概念間の関係性）
- 矛盾検知の高度化（タグ完全一致 → 埋め込み類似度ベースの包括的矛盾検出）
- ドメイン安定性に基づく自動再検証スケジュール（`knowledge-acquisition.md` §6.3 の陳腐化対処の Phase 2）

**触れる既存ファイル**
- `src/knowledge-manager.ts` — 検索メソッドをタグ完全一致から VectorIndex 経由に切り替え、矛盾検知の高度化
- `src/types/knowledge.ts` — `KnowledgeEntry` に `embedding_id?: string` フィールド追加、グラフエッジ型追加
- `src/session-manager.ts` — コンテキスト注入の知識検索をベクトル検索に切り替え

**新規作成が必要なファイル**
- `src/knowledge-graph.ts` — KnowledgeGraph クラス（概念ノード・関係エッジの CRUD、整合性チェック）

**依存関係**
- 12.1（EmbeddingClient, VectorIndex）が必要
- 12.7（記憶ライフサイクル Phase 2）の意味的インデックスと連動

---

### 12.3 好奇心 Phase 2

**設計ドキュメント**: `docs/design/curiosity.md` §4.3・4.4 Phase 2

**何をするか**
- クロスゴール転移: MVP の `dimension_name` 完全一致 → 埋め込みによるファジー類似度（異なる名前でも構造的に同種の次元を検出）
- 盲点検出: LLM ヒューリスティック (`detection_method: "llm_heuristic"`) → 埋め込み類似度 (`detection_method: "embedding_similarity"`)、高確信度化

**触れる既存ファイル**
- `src/curiosity-engine.ts` — 転移候補検出ロジック（`detectCrossGoalTransfer`）と盲点検出ロジック（`detectBlindSpots`）を埋め込みベースに書き換え
- `src/types/curiosity.ts` — `detection_method` 列挙型に `"embedding_similarity"` 追加

**新規作成が必要なファイル**
なし（12.1 の VectorIndex を呼ぶだけ）

**依存関係**
- 12.1（VectorIndex）が必要
- 12.2（ゴール横断ナレッジベース）の完成後に転移の精度が向上

---

### 12.4 満足化の意味的マッピング

**設計ドキュメント**: `docs/design/satisficing.md` §7 Phase 2（残り）

**何をするか**
- MVP: 名前一致による直接マッピングのみ
- Phase 2: 意味的類似度による自動マッピング提案（サブゴール次元 → 上位ゴール次元の自動マッチング）
- `dimension_mapping.aggregation` の自動提案（min/avg/max/all_required の推奨）

**触れる既存ファイル**
- `src/satisficing-judge.ts` — `proposeDimensionMapping()` メソッドを追加（埋め込み類似度でサブゴール次元と上位次元をマッチング）
- `src/types/satisficing.ts` — 自動マッピング提案の型追加（`MappingProposal`）
- `src/goal-negotiator.ts` — ゴール分解時に自動マッピング提案を活用

**新規作成が必要なファイル**
なし

**依存関係**
- 12.1（EmbeddingClient）が必要

---

### 12.5 状態ベクトル Phase 2

**設計ドキュメント**: `docs/design/state-vector.md` §8 Phase 2

**何をするか**
- 集約次元マッピング全種対応（all_required / min / avg / max）
  - 注: Stage 11B で `satisficing-judge.ts` に集約マッピング全種を追加済み。状態ベクトル側のデータ構造反映が対象
- マイルストーンペース評価（on_track / at_risk / behind）とリスケジュール提案
  - `state-vector.md` §8 の `pace_evaluation()` の完全実装
  - behind 時のリスケジュール選択肢（期限延長 / 目標下方修正 / ゴール再交渉トリガー）

**触れる既存ファイル**
- `src/types/state.ts` — `Dimension` 型に `dimension_mapping` フィールド追加、`Milestone` 型に `type: "milestone"`, `target_date`, `pace_snapshot` 追加
- `src/state-manager.ts` — マイルストーン追跡、ペース評価ロジック、リスケジュール提案生成
- `src/core-loop.ts` — マイルストーン期限チェックの組み込み
- `src/types/goal.ts` — ゴールツリーノードの `type` フィールドに `"milestone"` 追加

**新規作成が必要なファイル**
なし

**依存関係**
- 12.1 には依存しない（埋め込みは不要）
- 独立して実装可能だが、12.4 の意味的マッピングと相互補完する

---

### 12.6 セッション・コンテキスト Phase 2

**設計ドキュメント**: `docs/design/session-and-context.md` §4・9 Phase 2

**何をするか**
- バジェットベースの動的コンテキスト選択（MVP の固定 top-4 → トークンバジェットに応じた動的選択）
- ゴール依存グラフの実装（4タイプ: prerequisite / resource_conflict / synergy / conflict）
- LLM によるゴール間依存関係の自動検出（`auto_detect_dependencies()`）
- 依存グラフに基づくスケジューリング制御（resource_conflict 時の排他制御、prerequisite 時のタスク生成抑制）

**触れる既存ファイル**
- `src/session-manager.ts` — コンテキスト選択を動的バジェット方式に拡張
- `src/types/session.ts` — コンテキストバジェット設定型、依存グラフエッジ型追加
- `src/core-loop.ts` — 依存グラフに基づくスケジューリング制御（`boost_drive_score`, `skip_task_generation` ロジック）
- `src/state-manager.ts` — 依存グラフの永続化（`~/.motiva/dependency-graph.json`）

**新規作成が必要なファイル**
- `src/goal-dependency-graph.ts` — GoalDependencyGraph クラス（DAG 管理、循環検出、エッジ CRUD、スケジューリング影響の計算）
- `src/types/dependency.ts` — DependencyEdge, DependencyGraph, DependencyType Zod スキーマ

**依存関係**
- 12.1 には直接依存しない（自動検出は LLM 呼び出しのみで十分）
- ただし 12.7 の意味的インデックスとは連動

---

### 12.7 記憶ライフサイクル Phase 2

**設計ドキュメント**: `docs/design/memory-lifecycle.md` §5.2・6.2・7 Phase 2

**何をするか**
- Drive-based Memory Management（DriveScorer/SatisficingJudge 連携）:
  - 不満駆動: 高不満次元のデータは圧縮を最大2倍遅延
  - 締切駆動: 締切ボーナス（最大 30%）で Working Memory に優先引き出し
  - 機会駆動: 類似の好機パターンを Long-term から優先検索
  - SatisficingJudge: 「十分」判定次元を早期圧縮
- 意味的検索による Working Memory 選択（タグ完全一致 → 埋め込みベース）
- 参照頻度ベースの動的アーカイブ（N 回連続未参照でアクティブインデックス除外）
- Long-term 教訓のゴール横断検索（埋め込みインデックスによる）
- 圧縮品質の改善: 要約の再帰的精緻化、失敗エントリとの完全照合（MVP の比率チェックから移行）
- 高度な統計: トレンド分析、異常検知パターン

**触れる既存ファイル**
- `src/memory-lifecycle.ts` — Drive-based 管理ロジック追加（`compression_delay()`, `deadline_bonus()`, `mark_for_early_compression()`）、Working Memory 選択を VectorIndex 経由に切り替え
- `src/types/memory-lifecycle.ts` — `RelevanceScore`, `CompressionPolicy` 型追加、インデックスエントリに `embedding_id` 追加
- `src/drive-scorer.ts` — スコアを記憶管理に公開する新メソッド（または既存スコア取得 API の活用）
- `src/satisficing-judge.ts` — 完了判定フック（`on_satisficing_judgment` → `memory-lifecycle.ts` への通知）

**新規作成が必要なファイル**
なし（12.1 の VectorIndex を memory-lifecycle.ts から呼ぶ）

**依存関係**
- 12.1（VectorIndex）が必要
- DriveScorer（Stage 2 実装済み）と SatisficingJudge（Stage 2/11 実装済み）との連携

---

## Stage 12 内の依存関係グラフ

```
12.1 埋め込み基盤（EmbeddingClient + VectorIndex）
  ├── 12.2 知識獲得 Phase 2（ベクトル検索、知識グラフ）
  │     └── 12.3 好奇心 Phase 2（クロスゴール転移の精度向上）
  ├── 12.3 好奇心 Phase 2（盲点検出の高度化）
  ├── 12.4 満足化の意味的マッピング
  └── 12.7 記憶ライフサイクル Phase 2（意味的 Working Memory 選択）

12.5 状態ベクトル Phase 2 ← 12.1 に依存しない。独立実装可能
12.6 セッション・コンテキスト Phase 2 ← 12.1 に依存しない。独立実装可能
```

**推奨実装順序**: 12.1 → 12.5/12.6 (並行可) → 12.2/12.4/12.7 (並行可) → 12.3

---

## 新規ファイル一覧（Stage 12 で作成）

| ファイル | 役割 |
|---------|------|
| `src/embedding-client.ts` | 埋め込み生成・類似度計算 |
| `src/vector-index.ts` | ベクトル検索インフラ（ファイルベース） |
| `src/types/embedding.ts` | EmbeddingEntry, VectorSearchResult 等 |
| `src/knowledge-graph.ts` | 知識グラフ（概念間関係） |
| `src/goal-dependency-graph.ts` | ゴール依存グラフ（DAG、スケジューリング制御） |
| `src/types/dependency.ts` | DependencyEdge, DependencyGraph 等 |

---

## 主要な変更が入る既存ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `src/llm-client.ts` | `embed()` メソッド追加 |
| `src/knowledge-manager.ts` | 検索をベクトルベースに切り替え、矛盾検知高度化 |
| `src/curiosity-engine.ts` | 転移検出・盲点検出を埋め込みベースに |
| `src/satisficing-judge.ts` | 自動マッピング提案、SatisficingJudge→MemoryLifecycle フック |
| `src/memory-lifecycle.ts` | Drive-based 管理、意味的 Working Memory 選択 |
| `src/session-manager.ts` | 動的バジェット選択、依存グラフ参照 |
| `src/state-manager.ts` | マイルストーン追跡・ペース評価、依存グラフ永続化 |
| `src/core-loop.ts` | マイルストーン期限チェック、依存グラフ基づくスケジューリング |
| `src/goal-negotiator.ts` | 自動マッピング提案の活用 |
| `src/types/state.ts` | Milestone 型、dimension_mapping フィールド |
| `src/types/goal.ts` | milestone ノード型 |
| `src/types/knowledge.ts` | embedding_id フィールド、グラフエッジ型 |
| `src/types/memory-lifecycle.ts` | RelevanceScore, embedding_id 等 |
| `src/types/curiosity.ts` | detection_method に embedding_similarity 追加 |
| `src/index.ts` | 新クラスエクスポート |

---

## リスクと注意点

| リスク | 詳細 | 対応方針 |
|--------|------|---------|
| 埋め込みモデルの技術選定 | Anthropic/OpenAI どちらを使うか未確定 | 12.1 実装時に技術調査を先行。IEmbeddingClient インターフェースで差し替え可能にする |
| ベクトル検索のスケーラビリティ | ファイルベースで始めるが大量エントリで遅延 | ローカルファイルベースから開始。ボトルネック化したら外部 DB（SQLite-vec 等）に移行 |
| 12.5 マイルストーン実装範囲 | state-vector.md §8 は詳細設計済みだが、ゴールツリーの既存実装との統合複雑性がある | CoreLoop への組み込みを最小限に抑え、StateManager 内で完結させる |
| 12.6 の 12.7 との順序 | 依存グラフが完成してから記憶ライフサイクル Phase 2 を実装すべきか | 独立しているため並行可能。依存グラフの影響は memory-lifecycle に届かない |

---

## ギャップ（未確定事項）

- **埋め込みモデル選定**: Anthropic text-embedding-3 vs OpenAI text-embedding-3-small — どちらを MVP とするか設計書に記載なし (**Uncertain**)
- **VectorIndex の実装ライブラリ**: 純粋な cosine similarity の手実装か、vectra / usearch 等のライブラリを使うか未確定 (**Uncertain**)
- **12.5 と既存 TaskLifecycle の重なり**: マイルストーン到達時の強制観測が `src/task-lifecycle.ts` を呼ぶか `src/observation-engine.ts` を直接呼ぶかが不明 (**Uncertain**)
- **Stage 11B の集約マッピング実装範囲**: `satisficing-judge.ts` に min/avg/max/all_required は追加済みだが、`state-vector.ts` の `dimension_mapping` フィールドが既に存在するかどうか未確認 (**Confirmed** as missing — status.md に state.ts への言及なし)

---

## 前提確認（Stage 12 着手前）

- Stage 10: 完了済み (**Confirmed** — status.md, CLAUDE.md より)
- Stage 11: 完了済み (**Confirmed**)
- `src/memory-lifecycle.ts`: MVP 実装済み（3層モデル、タグベース検索、LLM 圧縮）(**Confirmed** — status.md 10.5)
- `src/knowledge-manager.ts`: タグ完全一致検索実装済み (**Confirmed** — status.md 8)
- `src/curiosity-engine.ts`: dimension_name 完全一致の転移検出実装済み (**Confirmed** — status.md 11C)
