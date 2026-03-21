# Motiva LLM呼び出し分析レポート

作成日: 2026-03-21
対象: Stage 1-14 + M1-18 + Phase 3 + OSS最適化完了時点のコードベース

---

## 1. LLM呼び出し箇所一覧

### 1.1 観測系 (Observation)

#### `src/observation/observation-llm.ts` — `observeWithLLM()`
- **目的**: ゴールディメンションを0.0〜1.0でスコアリング（LLM独立レビュー層）
- **システムプロンプト**: なし（user-onlyメッセージ構造）
- **ユーザープロンプト**:
  - ゴール説明 (`goalDescription`)
  - ディメンション名・ラベル (`dimensionLabel`)
  - 閾値の説明 (`thresholdDescription`)
  - 前回スコア (`previousScore`)
  - ワークスペースコンテキスト（最大4000文字）
  - Few-shot校正例（TODO/FIXME判定例）
- **注入されているコンテキスト**:
  - ワークスペースコンテキスト（引数経由、または`fetchGitDiffContext()`フォールバック）
  - gitdiff（フォールバック時、最大3000文字）
- **欠けているコンテキスト**:
  - 過去の観測履歴（`dim.history`に入っているのに使われていない）
  - 関連するナレッジエントリ（KnowledgeManagerで取得可能）
  - ディメンションの信頼度履歴
  - 他ディメンションの状態（横断的観測可能性）
- **トークン予算意識**: `MAX_CONTEXT_CHARS = 4000`で粗くtruncate。ティア分類なし。

---

### 1.2 タスク生成系 (Task Generation)

#### `src/execution/task-generation.ts` — `generateTask()`
- **目的**: ゴール・ターゲットディメンションに対して具体的なタスクをLLM生成
- **システムプロンプト**: `"You are a task generation assistant. Given a goal and target dimension, generate a concrete, actionable task. Respond with a JSON object inside a markdown code block."`
- **ユーザープロンプト** (`task-prompt-builder.ts:buildTaskGenerationPrompt()`):
  - ゴールタイトル・説明
  - ディメンション名・ラベル・現在値・閾値・ギャップ
  - リポジトリ情報（package.json: name, description）
  - アダプタ種別に応じた実行コンテキスト（github_issue / codex-cli / claude-code-cli）
  - ナレッジコンテキスト（引数経由）
  - ワークスペースコンテキスト（引数経由）
  - 既存タスク一覧（重複回避用）
  - 前回失敗コンテキスト（`last-failure-context.json`から）
- **欠けているコンテキスト**:
  - `MemoryLifecycleManager`の短期メモリ（lessons, statistics）
  - 戦略テンプレート（`StrategyTemplateRegistry`）
  - 過去の観測ログ（次のディメンション改善に向けたトレンド）
  - `LearningPipeline`のパターン（何が効いたか）
  - 反省ノート（`ReflectionNote`）
- **トークン予算意識**: なし（固定プロンプト）

#### `src/execution/task-generation.ts` — `generateTaskGroup()`
- **目的**: 複雑タスクをサブタスク群（TaskGroup）に分解
- **システムプロンプト**: `"You are a task decomposition assistant. Respond with valid JSON only."`
- **ユーザープロンプト**:
  - ゴール説明
  - ターゲットディメンション
  - 現在の状態
  - ギャップ値
  - 利用可能なアダプタ一覧
- **欠けているコンテキスト**:
  - ナレッジコンテキスト（generateTaskには渡されるがgenerateTaskGroupには渡されない）
  - ワークスペースコンテキスト（同上）
  - 前回失敗コンテキスト

---

### 1.3 タスク検証系 (Task Verification)

#### `src/execution/task-verifier.ts` — `runLLMReview()`
- **目的**: タスク実行結果を成功基準に照らして独立評価（L2レイヤー）
- **システムプロンプト**: `"Review task results objectively against criteria. Ignore executor self-assessment."`
- **ユーザープロンプト**:
  - タスク説明 (`work_description`)
  - アプローチ
  - 成功基準一覧（各基準: 説明・検証方法・blocking）
  - エグゼキュータの出力（最初の2000文字）
  - 停止理由・成功フラグ
  - レビューコンテキスト（`sessionManager.buildTaskReviewContext()`から）
- **欠けているコンテキスト**:
  - 過去の検証履歴（同類タスクのパターン）
  - ディメンションの現在の数値（どこからどこに変化したか）
  - ナレッジ（何が正しい状態か）

#### `src/execution/task-verifier.ts` — `attemptRevert()`
- **目的**: 失敗した可逆タスクの変更を元に戻す
- **システムプロンプト**: `"Revert failed task changes. Respond with JSON only."`
- **ユーザープロンプト**: タスク名・スコープ範囲（in_scope）
- **欠けているコンテキスト**: 実際の変更内容（git diffなど）

---

### 1.4 ゴール交渉系 (Goal Negotiation)

#### `src/goal/negotiator-prompts.ts` — `buildDecompositionPrompt()`
経由: `negotiator-steps.ts:runDecompositionStep()`
- **目的**: ゴールをディメンション群に分解（Step 2）
- **システムプロンプト**: なし
- **ユーザープロンプト**:
  - ゴール説明
  - 制約一覧
  - 利用可能なデータソース（ObservationEngine.getAvailableDimensionInfo()）
  - ワークスペースコンテキスト（オプション）
- **欠けているコンテキスト**:
  - 過去のゴール分解事例（何次元が適切か）
  - ナレッジエントリ（ドメイン知識）

#### `src/goal/negotiator-prompts.ts` — `buildFeasibilityPrompt()`
経由: `negotiator-steps.ts:evaluateQualitatively()`
- **目的**: ディメンションごとのフィジビリティ評価（realistic/ambitious/infeasible）
- **システムプロンプト**: なし
- **ユーザープロンプト**: ディメンション名・ゴール説明・ベースライン値・目標値・時間軸
- **欠けているコンテキスト**: 過去の類似ゴールの達成実績

#### `src/goal/negotiator-prompts.ts` — `buildResponsePrompt()`
経由: `negotiator-steps.ts:buildNegotiationResponse()`
- **目的**: ユーザーへの交渉応答文（accept/counter_propose/flag_as_ambitious）を生成
- **システムプロンプト**: なし
- **ユーザープロンプト**: ゴール説明・フィジビリティ評価結果・カウンタープロポーザル

#### `src/goal/goal-suggest.ts` — `buildCapabilityCheckPrompt()`
経由: `negotiator-steps.ts:runCapabilityCheckStep()`
- **目的**: ゴール達成に必要なCapabilityと利用可能なAdapterのギャップ検出
- **システムプロンプト**: なし
- **ユーザープロンプト**: ゴール説明・ディメンション一覧・アダプタCapability一覧

---

### 1.5 ゴール分解・提案系 (Goal Decomposition/Suggestion)

#### `src/goal/goal-decomposer.ts` — `decompose()`
- **目的**: ゴールを倫理チェック付きサブゴールに分解
- **システムプロンプト**: なし
- **ユーザープロンプト**: ゴールタイトル・説明・ディメンション一覧（閾値付き）
- **欠けているコンテキスト**: 過去のサブゴール分解事例

#### `src/goal/goal-suggest.ts` — `suggestGoals()`
- **目的**: プロジェクトコンテキストからゴール候補を提案
- **システムプロンプト**: なし（ユーザープロンプトに埋め込み）
- **ユーザープロンプト**: コンテキスト文字列・提案上限数・既存ゴール一覧
- **欠けているコンテキスト**: CapabilityDetectorとの連携（オプションだが渡されないことが多い）

#### `src/goal/goal-tree-manager.ts` — `buildSpecificityPrompt()` / `buildSubgoalPrompt()`
- **目的**: ゴールの具体性スコアリング・サブゴール生成（GoalTree分解）
- **システムプロンプト**: なし
- **ユーザープロンプト**:
  - specificity: ゴールタイトル・説明・ディメンション名・深さ
  - subgoal: ゴール情報・深さ・最大深さ・最大子数・制約

#### `src/goal/goal-tree-quality.ts` — `buildConcretenessPrompt()` / `buildQualityEvaluationPrompt()`
- **目的**: ゴールの具体性評価・分解品質評価（coverage/overlap/actionability）
- **ユーザープロンプト**:
  - concreteness: ゴール説明のみ
  - quality: 親ゴール説明・サブゴール説明一覧

#### `src/goal/goal-dependency-graph.ts` — `autoDetect()`
- **目的**: ゴール間の依存関係を自動検出（prerequisite/resource_conflict/synergy/conflict）
- **ユーザープロンプト**: ゴール一覧（説明・ディメンション）

---

### 1.6 倫理ゲート (Ethics)

#### `src/traits/ethics-gate.ts` — `check()` / `checkMeans()`
- **目的**: ゴール・サブゴール・タスクの倫理評価（Layer 2 LLM）
- **システムプロンプト**: `ETHICS_SYSTEM_PROMPT`（Motivaペルソナ + 評価ルール。約50行）
- **ユーザープロンプト**:
  - サブジェクト種別（goal/subgoal/task）
  - 説明
  - 追加コンテキスト（オプション）
  - カスタム制約（CustomConstraintsConfig）
- **注記**: Layer 1はLLM不使用（正規表現ルール）。Layer 2のみLLM。

---

### 1.7 戦略系 (Strategy)

#### `src/strategy/strategy-helpers.ts` — `buildGenerationPrompt()`
経由: `strategy-manager-base.ts:generateCandidates()`
- **目的**: ゴールギャップを閉じるための戦略候補（1〜2件）を生成
- **システムプロンプト**: `"You are a strategic planning assistant. Generate concrete, actionable strategies to close the goal gap. Respond with a JSON array of 1–2 strategies."`
- **ユーザープロンプト**:
  - goalId・primaryDimension・targetDimensions
  - 現在のギャップスコア
  - 過去に試した戦略一覧（仮説・状態・有効性スコア）
- **欠けているコンテキスト**:
  - ナレッジエントリ（ドメイン知識）
  - 観測ログ（何が原因でギャップがあるか）
  - `DecisionRecord`（過去の意思決定と成果）
  - `LearningPipeline`のパターン
  - StrategyTemplateRegistry（過去の成功テンプレート）

#### `src/strategy/strategy-template-registry.ts` — `generalizeHypothesis()` / `adaptTemplate()`
- **目的**: 完了戦略を抽象化してテンプレート化 / 別ゴールへの適用
- **ユーザープロンプト**:
  - generalize: 元のhypothesis
  - adapt: 元テンプレート・source/targetゴールID

---

### 1.8 好奇心エンジン (Curiosity)

#### `src/traits/curiosity-proposals.ts` — `generateProposals()`
- **目的**: 好奇心トリガーに基づいて探索ゴール候補を提案
- **システムプロンプト**: なし
- **ユーザープロンプト**:
  - トリガー種別・詳細・深刻度・ソースゴールID
  - アクティブゴール一覧（ディメンション名・origin）
  - 直近10件の学習レコード（アプローチ・成果・改善比率）
- **欠けているコンテキスト**:
  - ゴールの数値（currentValue）
  - ナレッジエントリ

---

### 1.9 ナレッジ系 (Knowledge)

#### `src/knowledge/knowledge-manager.ts` — `detectKnowledgeGap()`
- **目的**: 観測・戦略コンテキストからナレッジギャップを検出
- **システムプロンプト**: `"You are a knowledge gap detector. Analyze contexts to identify missing domain knowledge. Respond with JSON only."`
- **ユーザープロンプト**: 観測一覧（最大500文字）・戦略一覧（最大500文字）・信頼度

#### `src/knowledge/knowledge-manager.ts` — `generateAcquisitionTask()`
- **目的**: ナレッジギャップに対応する調査タスクを生成
- **システムプロンプト**: `"You generate knowledge acquisition tasks. Produce 3-5 specific research questions. Respond with JSON only."`
- **ユーザープロンプト**: goalId・ギャップシグナル（種別・欠如している知識・関連ディメンション）

#### `src/knowledge/knowledge-manager.ts` — `checkContradiction()`
- **目的**: 新規ナレッジエントリと既存エントリの矛盾検出
- **システムプロンプト**: `"You are a knowledge consistency checker. Detect factual contradictions between knowledge entries. Respond with JSON only."`
- **ユーザープロンプト**: 新エントリ（Q&A・タグ）・既存エントリ（同タグ）

#### `src/knowledge/knowledge-revalidation.ts` — `classifyDomainStability()`
- **目的**: ナレッジドメインの安定性を分類（stable/moderate/volatile）
- **システムプロンプト**: `"You classify knowledge domain stability. Respond with JSON only."`
- **ユーザープロンプト**: ドメイン名・サンプルエントリ（最大5件のQ&A）

#### `src/knowledge/knowledge-decisions.ts` — `enrichDecisionRecord()`
- **目的**: 意思決定レコードにwhat_worked/what_failed/suggested_nextを付与
- **システムプロンプト**: なし
- **ユーザープロンプト**: 決定内容・成果・戦略ID・コンテキスト（最大500文字）

---

### 1.10 メモリ圧縮・蒸留系 (Memory Distill/Compression)

#### `src/knowledge/memory-distill.ts` — `extractPatterns()`
- **目的**: 短期メモリエントリから繰り返しパターンを抽出
- **システムプロンプト**: `"You are a pattern extraction engine. Analyze experience logs and identify recurring patterns, successes, and failures. Respond with JSON only."`
- **ユーザープロンプト**: エントリ一覧（最大20件、data_type/loop_number/dimensions/tags/data）

#### `src/knowledge/memory-distill.ts` — `distillLessons()`
- **目的**: パターンを構造化された教訓（LessonEntry）に変換
- **システムプロンプト**: `"You are a lesson distillation engine. Convert experience patterns into structured, actionable lessons. Respond with JSON only."`
- **ユーザープロンプト**: パターン一覧・失敗エントリ（最大5件のdata）

---

### 1.11 ナレッジ転送系 (Knowledge Transfer)

#### `src/knowledge/knowledge-transfer-prompts.ts` — `buildAdaptationPrompt()`
- **目的**: 学習済みパターンを別ゴールのコンテキストに適応
- **ユーザープロンプト**: ソースパターン詳細・ソース/ターゲットゴールID

#### `src/knowledge/knowledge-transfer-prompts.ts` — `buildMetaPatternPrompt()`
- **目的**: 複数パターンからドメイン横断メタパターンを抽出
- **ユーザープロンプト**: パターン一覧（最大50件、type/description/confidence/domains）

---

### 1.12 学習パイプライン (Learning Pipeline)

#### `src/knowledge/learning-pipeline-prompts.ts` — `buildExtractionPrompt()`
- **目的**: 経験ログからstate→action→outcome トリプレットを抽出
- **ユーザープロンプト**: トリガー情報・経験ログ（JSON形式）

#### `src/knowledge/learning-pipeline-prompts.ts` — `buildPatternizationPrompt()`
- **目的**: トリプレットから繰り返しパターンを識別・分類
- **ユーザープロンプト**: トリプレット一覧（JSON形式）

---

### 1.13 反省生成系 (Reflection)

#### `src/execution/reflection-generator.ts` — `generateReflection()`
- **目的**: タスク実行結果を構造化された反省ノートに変換
- **システムプロンプト**: なし
- **ユーザープロンプト**: タスク説明・verdict・confidence・証拠（evidence descriptions）
- **欠けているコンテキスト**:
  - ゴール状態（どのディメンションに影響したか）
  - 過去の反省ノート（パターンの継続性）

---

### 1.14 実行パイプライン系 (Execution Pipeline)

#### `src/execution/impact-analyzer.ts` — `analyzeImpact()`
- **目的**: タスク実行後の意図しない副作用を検出
- **システムプロンプト**: `"You are an impact analyzer. Identify unintended side effects objectively. Respond with JSON only."`
- **ユーザープロンプト**: タスク説明・検証verdict・期待スコープ・タスク出力（最初の2000文字）

#### `src/execution/result-reconciler.ts` — `reconcileResults()`
- **目的**: 並列サブタスクの結果間の意味的矛盾を検出
- **システムプロンプト**: なし
- **ユーザープロンプト**: タスクAの出力（verdict付き）・タスクBの出力

---

### 1.15 CapabilityDetector系

#### `src/observation/capability-detector.ts` — `detectDeficiency()` / `detectGoalCapabilityGap()`
- **目的**: タスク失敗からCapability不足を検出 / ゴールレベルのCapabilityギャップ検出
- **ユーザープロンプト**:
  - detectDeficiency: タスク説明・失敗理由・既存Capability一覧
  - detectGoalCapabilityGap: ゴール説明・既存Capability一覧

---

### 1.16 TUI/IntentRecognizer系

#### `src/tui/intent-recognizer.ts` — `llmFallback()`
- **目的**: ユーザー入力のインテント認識（keyword matchフォールバック）
- **システムプロンプト**: Motivaの説明・利用可能アクション一覧
- **ユーザープロンプト**: ユーザー入力そのまま

---

### 1.17 Memory Tier分類 (LLM補助)

#### `src/knowledge/memory-tier.ts` — `llmClassifyTier()`
- **目的**: メモリエントリのティア分類をLLMで補助（ルールベースのフォールバック付き）
- **ユーザープロンプト**: アクティブゴール情報・エントリ一覧（entry_id/dimensions/tags/last_accessed）

---

## 2. 既存コンテキスト基盤の能力マップ

### 2.1 `src/observation/context-provider.ts`
**提供能力**:
- `buildWorkspaceContext()`: ディメンション名からgrep検索 → 関連ファイル内容（最大100行×3ファイル）
- `buildWorkspaceContextItems()`: ContextItem配列（label/content/memory_tier付き）
- `selectByTier()`: core/recall/archivalの優先度でアイテム選択
- グレップ結果 → recall tier
- git diff HEAD~1 --stat → recall tier
- テスト状態（vitest最終10行）→ recall tier

**制限**:
- ディメンション名をgrep検索語に変換するロジックが単純（TODO/FIXME/test等の固定マッピング）
- `.ts/.js`ファイルしか対象にしない
- 最大ファイル数5、読み込み3ファイルのハードコード

### 2.2 `src/knowledge/memory-tier.ts`
**提供能力**:
- `classifyTier()`: ShortTermEntry/MemoryIndexEntryをcore/recall/archivalに分類
  - core: activeゴール + coreデータ型 + 直近5時間/5ループ
  - recall: activeゴール（それ以外）
  - archival: 完了ゴールまたは未登録ゴール
- `computeDynamicBudget()`: 不満足スコアに基づく動的バジェット割当
  - 不満足 > 0.7: core 70% / recall 25% / archival 5%
  - 不満足 > 0.4: core 60% / recall 30% / archival 10%
  - それ以外: core 50% / recall 35% / archival 15%
- `sortByTier()` / `filterByTierBudget()`: エントリの並べ替え・フィルタリング
- `llmClassifyTier()`: LLMによるティア分類補助

**未接続箇所**: LLM呼び出しへの接続なし（memory-lifecycle.tsに閉じている）

### 2.3 `src/knowledge/memory-lifecycle.ts` (MemoryLifecycleManager)
**提供能力**:
- 3層メモリ (working / short-term / long-term)
- `selectForWorkingMemory()`: 優先度スコアによる選択
- `selectForWorkingMemorySemantic()`: VectorIndex経由のセマンティック検索
- `searchCrossGoalLessons()`: 全ゴール横断でlessons検索
- `compressToLongTerm()`: 短期→長期圧縮（LLM使用）
- `onSatisficingJudgment()`: 満足判定をメモリ状態に反映
- `onTaskFailure()`: タスク失敗を早期圧縮候補としてマーク

**実際の利用状況**:
- CoreLoopから`onSatisficingJudgment()`は呼ばれている
- しかし、**LLMプロンプトにworking memoryを注入している箇所はほぼ皆無**

### 2.4 `src/execution/context-budget.ts`
**提供能力**:
- `allocateTierBudget()`: totalTokens → {core, recall, archival}に50/35/15%配分
- `allocateBudget()`: {goalDefinition: 20%, observations: 30%, knowledge: 30%, transferKnowledge: 15%, meta: 5%}
- `estimateTokens()`: 文字数/4でトークン概算
- `selectWithinBudget()`: 類似度降順でバジェット内選択
- `trimToBudget()`: 超過時に優先度低いカテゴリから削減

**実際の利用状況**:
- **どのLLM呼び出しでも直接使用されていない**
- `memory-lifecycle.ts`内部でのみ概念が使われている

### 2.5 `src/knowledge/knowledge-manager.ts` (KnowledgeManager)
**提供能力**:
- `getRelevantKnowledge()`: ディメンション名タグでナレッジエントリ検索
- `searchKnowledge()`: VectorIndex経由のセマンティック検索（単一ゴール）
- `searchAcrossGoals()`: VectorIndex経由のクロスゴール検索
- `querySharedKnowledge()`: タグによる共有KB検索
- `searchByEmbedding()`: 埋め込みベースの類似検索
- `queryDecisions()`: goal_typeでDecisionRecord検索（時間減衰付き）

**実際の利用状況**:
- `generateTask()`には`knowledgeContext`（文字列）として渡される経路がある
- ただし、この接続は`core-loop.ts`または`task-lifecycle.ts`経由で手動で行う必要があり、常に行われているわけではない

### 2.6 `src/knowledge/memory-distill.ts`
**提供能力**:
- `extractPatterns()`: 短期エントリからパターン抽出（LLM）
- `distillLessons()`: パターンを構造化教訓に変換（LLM）
- `validateCompressionQuality()`: 失敗カバレッジ比率チェック

**実際の利用状況**:
- `memory-compression.ts`経由で長期圧縮時に使用
- ただし、圧縮済み教訓は**タスク生成やその他のLLMプロンプトに再注入されていない**

---

## 3. ギャップ分析（使えるのに使われていない機能）

### 3.1 Critical Gap: 長期メモリ教訓がタスク生成プロンプトに未注入

**現状**: `MemoryLifecycleManager`は圧縮・蒸留した教訓（LessonEntry）をlong-termメモリに保持している。

**問題**: `generateTask()`や`generateCandidates()`は`knowledgeContext`を受け取れる設計だが、実際に`selectForWorkingMemory()`または`queryLessons()`の結果を渡す経路が整備されていない。

**影響**: タスク生成LLMが過去の失敗・成功パターンを知らない状態で新規タスクを生成している。

### 3.2 Critical Gap: 観測プロンプトにディメンション履歴が未注入

**現状**: `observeWithLLM()`は`previousScore`（スカラー値）のみ渡している。

**問題**: `dim.history`には過去の観測値の時系列データがあり、トレンド（上昇中・下降中・横ばい）を伝えられるのに使われていない。

**影響**: LLMが現在のスコアだけを見て判断し、異常なスコアジャンプを見逃す可能性がある（スコアジャンプ抑制は実装されているが、トレンド情報があればより精度が上がる）。

### 3.3 Important Gap: context-budget.tsがLLM呼び出しに未接続

**現状**: `allocateBudget()` / `selectWithinBudget()` / `trimToBudget()`は設計通りに実装されている。

**問題**: 実際のLLMプロンプト構築では固定文字数制限（`MAX_CONTEXT_CHARS = 4000`など）が使われており、バジェット管理関数が使用されていない。

**影響**: トークン超過・不足が管理できない。重要な情報が切り捨てられる可能性がある。

### 3.4 Important Gap: ReflectionNoteがタスク生成に未活用

**現状**: `generateReflection()`はタスク実行後に反省を生成し、`saveReflectionAsKnowledge()`でナレッジとして保存する経路がある。`formatReflectionsForPrompt()`というフォーマッタも実装済み。

**問題**: `getReflectionsForGoal()`と`formatReflectionsForPrompt()`の結果が`buildTaskGenerationPrompt()`に渡されていない。

**影響**: 「次に何をしてはいけないか」の情報がタスク生成に活用されていない。

### 3.5 Important Gap: StrategyTemplateRegistryが戦略生成に未接続

**現状**: `StrategyTemplateRegistry`は成功戦略をテンプレート化し、セマンティック検索（VectorIndex）・適応（LLM）機能を持つ。

**問題**: `buildGenerationPrompt()`はpastStrategies（このゴールの過去戦略のみ）を受け取るが、StrategyTemplateRegistryからのテンプレート候補は受け取らない。

**影響**: 別ゴールで成功した戦略が新規ゴールに適用されない。

### 3.6 Minor Gap: generateTaskGroupがknowledge/workspaceコンテキストを受け取らない

**現状**: `generateTask()`は`knowledgeContext`/`workspaceContext`を引数として受け取る。

**問題**: `generateTaskGroup()`は同様の引数を持たない。

### 3.7 Minor Gap: CapabilityDetector結果がタスク生成に未反映

**現状**: `detectDeficiency()`がタスク失敗から能力不足を検出するが、次のタスク生成プロンプトにそのギャップ情報が注入されない。

### 3.8 Minor Gap: llmClassifyTierがILLMClientインターフェースと不一致

**現状**: `llmClassifyTier()`は`generateStructured`メソッドを期待するが、`ILLMClient`のインターフェースには`sendMessage()`しかない。実質的に使用不可能。

---

## 4. 改善機会の特定（優先度付き）

### Priority 1 (High): 長期メモリ教訓のタスク生成への注入

**対象ファイル**:
- `src/loop/core-loop-phases.ts` または `task-lifecycle.ts` (タスク生成呼び出し箇所)
- `src/execution/task-prompt-builder.ts` (プロンプトへのセクション追加)
- `src/knowledge/memory-lifecycle.ts` (`queryLessons()` or `selectForWorkingMemory()`)

**実装アイデア**:
```
// task-prompt-builder.ts への追加
const lessonsSection = lessons.length > 0
  ? `\n## 過去の教訓 (これを参考にタスクを生成すること)\n${formatLessons(lessons)}\n`
  : "";
```

**期待効果**: タスク生成精度向上。同じ失敗パターンの繰り返しを削減。

---

### Priority 1 (High): 反省ノートのタスク生成への注入

**対象ファイル**:
- `src/execution/task-prompt-builder.ts`
- `src/execution/task-lifecycle.ts`（`getReflectionsForGoal()`→`formatReflectionsForPrompt()`の呼び出し追加）

**実装アイデア**: `formatReflectionsForPrompt()`は既に`"## Past Reflections (learn from these)\n"`という書式で出力する。`buildTaskGenerationPrompt()`にこのセクションを追加するだけ。

**注意**: `knowledgeManager`が`task-lifecycle.ts`に注入済みかを確認する必要がある。

---

### Priority 2 (Medium): 観測プロンプトへのディメンション履歴注入

**対象ファイル**:
- `src/observation/observation-llm.ts:observeWithLLM()`

**実装アイデア**:
```
// previousScoreの代わりに直近5件のhistory
const trendText = dimension.history
  .slice(-5)
  .map(h => `${h.timestamp.slice(0,10)}: ${h.value}`)
  .join(", ");
// プロンプトに: `Trend (last 5): ${trendText}`
```

**注意**: `observeWithLLM()`シグネチャに`history`パラメータを追加する必要がある。

---

### Priority 2 (Medium): context-budget.tsを実際のプロンプト構築に接続

**対象ファイル**:
- `src/observation/observation-llm.ts` (MAX_CONTEXT_CHARSの代わりに`estimateTokens()`/`selectWithinBudget()`)
- `src/execution/task-prompt-builder.ts` (各セクションをbudget制御下に置く)

---

### Priority 2 (Medium): StrategyTemplateRegistryを戦略生成に接続

**対象ファイル**:
- `src/strategy/strategy-manager-base.ts:generateCandidates()`
- `src/strategy/strategy-helpers.ts:buildGenerationPrompt()`

**実装アイデア**:
```
// generateCandidates()に追加
const templates = await strategyTemplateRegistry.recommend(goalDescription, 3);
// buildGenerationPrompt()に渡す
const templateSection = templates.length > 0
  ? `\n過去の成功テンプレート:\n${templates.map(t => `- ${t.hypothesis_pattern}`).join("\n")}\n`
  : "";
```

---

### Priority 3 (Low): generateTaskGroupへのknowledge/workspaceコンテキスト追加

**対象ファイル**: `src/execution/task-generation.ts:generateTaskGroup()`

---

### Priority 3 (Low): llmClassifyTierのILLMClient互換修正

**対象ファイル**: `src/knowledge/memory-tier.ts:llmClassifyTier()`

`generateStructured`を`sendMessage()`ベースに修正する（または現在の実装がデッドコードであることを確認してドロップする）。

---

## 補足: コンテキスト接続の全体像（現状 vs 理想）

```
現状:
observeWithLLM()      ← workspaceContext (gitdiff)
generateTask()        ← workspaceContext + knowledgeContext + failureContext
generateCandidates()  ← pastStrategies (このゴールのみ)
verifyTask/runLLMReview() ← executionResult (最大2000文字)

理想:
observeWithLLM()      ← workspaceContext + dimensionHistory (トレンド)
generateTask()        ← workspaceContext + knowledgeContext + failureContext
                         + lessons (long-term memory)
                         + reflections (past reflections)
                         + capabilityGaps
generateCandidates()  ← pastStrategies + strategyTemplates (cross-goal)
                         + decisions (DecisionRecord)
verifyTask()          ← executionResult + knowledgeEntries (正しい状態の定義)
```

---

## 参照ファイルパス

| 機能 | ファイル |
|------|---------|
| LLM呼び出し: 観測 | `/src/observation/observation-llm.ts` |
| LLM呼び出し: タスク生成 | `/src/execution/task-generation.ts` |
| プロンプト構築: タスク | `/src/execution/task-prompt-builder.ts` |
| LLM呼び出し: 検証 | `/src/execution/task-verifier.ts` |
| LLM呼び出し: 交渉 | `/src/goal/negotiator-prompts.ts`, `/src/goal/negotiator-steps.ts` |
| LLM呼び出し: 倫理 | `/src/traits/ethics-gate.ts` |
| LLM呼び出し: 戦略 | `/src/strategy/strategy-helpers.ts`, `/src/strategy/strategy-manager-base.ts` |
| LLM呼び出し: 好奇心 | `/src/traits/curiosity-proposals.ts` |
| LLM呼び出し: ナレッジ | `/src/knowledge/knowledge-manager.ts`, `/src/knowledge/knowledge-decisions.ts` |
| LLM呼び出し: メモリ圧縮 | `/src/knowledge/memory-distill.ts` |
| LLM呼び出し: 学習 | `/src/knowledge/learning-pipeline-prompts.ts` |
| LLM呼び出し: 反省 | `/src/execution/reflection-generator.ts` |
| LLM呼び出し: 転送 | `/src/knowledge/knowledge-transfer-prompts.ts` |
| コンテキスト基盤: ワークスペース | `/src/observation/context-provider.ts` |
| コンテキスト基盤: ティア分類 | `/src/knowledge/memory-tier.ts` |
| コンテキスト基盤: メモリ管理 | `/src/knowledge/memory-lifecycle.ts` |
| コンテキスト基盤: バジェット | `/src/execution/context-budget.ts` |
| コンテキスト基盤: ナレッジ検索 | `/src/knowledge/knowledge-manager.ts` |
