# AIエージェントフレームワークにおけるプロンプトエンジニアリングとコンテキスト注入の比較研究

**作成日**: 2026-03-21
**対象**: LangGraph/LangChain, AutoGen, CrewAI, OpenAI Agents SDK, DSPy, Semantic Kernel, Claude/MCP, Voyager/GITM/Generative Agents, MemGPT/Letta, Reflexion/LATS
**目的**: 各フレームワークのプロンプト構造・メモリ注入・コンテキスト管理の比較・Motivaへの示唆抽出

---

## 目次

1. [LangGraph / LangChain](#1-langgraph--langchain)
2. [AutoGen (Microsoft)](#2-autogen-microsoft)
3. [CrewAI](#3-crewai)
4. [OpenAI Agents SDK](#4-openai-agents-sdk)
5. [DSPy](#5-dspy)
6. [Semantic Kernel (Microsoft)](#6-semantic-kernel-microsoft)
7. [Claude / MCP (Anthropic)](#7-claude--mcp-anthropic)
8. [Voyager / GITM / Generative Agents (研究論文系)](#8-voyager--gitm--generative-agents)
9. [MemGPT / Letta](#9-memgpt--letta)
10. [Reflexion / LATS](#10-reflexion--lats)
11. [共通パターンの抽出](#11-共通パターンの抽出)
12. [ベストプラクティスのまとめ](#12-ベストプラクティスのまとめ)
13. [Motivaへの示唆](#13-motivaへの示唆)

---

## 1. LangGraph / LangChain

**Confirmed**

### プロンプト構造

LangGraph/LangChainのエージェントLLM呼び出しは以下の3層で構成される。

```
[System Prompt]
  - エージェントのロール・能力定義
  - ユーザーロール/コンプライアンス要件に応じた動的適応
  - ミドルウェアが注入するスタイル・設定情報

[Messages / Conversation History]
  - 直近N件のユーザー・アシスタントの往復
  - ツール実行結果（tool_use/tool_result ペア）
  - 一時的なコンテキスト注入（ファイルメタデータ、文体見本等）

[Current User Input]
```

プロンプトテンプレートは `{user_input}`, `{history}`, `{context}` のようなプレースホルダーで動的に構成される。LangChain Expression Language (LCEL) がテンプレート合成を担う。

### コンテキストウィンドウ管理

LangGraphのコンテキストウィンドウ管理は4戦略に分類される（**Write / Select / Compress / Isolate**）。

| 戦略 | 手法 | 詳細 |
|------|------|------|
| **Write** | スクラッチパッド | エージェントがセッション中にメモを残す（state field / tool call経由）|
| **Write** | 長期メモリ | セッション横断でユーザー設定や知識を保存 |
| **Select** | セマンティック検索 | ツール説明や知識ベースからRAGで関連情報を取得 |
| **Compress** | サマリー | 容量の95%超過時に旧メッセージをLLMサマリーで置換 |
| **Compress** | トリミング | 直近N件のみ保持、古いメッセージを削除 |
| **Isolate** | マルチエージェント | 専門化されたエージェントが個別コンテキストウィンドウを持つ |
| **Isolate** | サンドボックス | コードエージェントは大きなオブジェクト（画像等）をLLMコンテキスト外で扱う |

### メモリ → プロンプトパイプライン

LangChainは3層のメモリを区別する。

1. **Short-term (State)**: セッションスコープ。現在のメッセージ・認証・アップロードファイル等。ミドルウェアがこれを読んでシステムプロンプトを動的にカスタマイズ。
2. **Long-term (Store)**: セッション横断。ユーザー設定・履歴インサイト・フィーチャーフラグ等。プロンプトカスタマイズとツールフィルタリングに利用。
3. **Runtime Context**: 静的設定（ユーザーID・APIキー・DB接続・権限）。

ミドルウェアが各LLM呼び出し前にこれらのソースから読み取り、条件付きで命令を修正する。

### 動的 vs 静的コンテキスト

- **静的**: エージェントロール定義、基本的な能力記述
- **動的**: ユーザー個別設定、メモリ検索結果、ツール選択、コンプライアンス要件

### トークンバジェット管理

`SummarizationMiddleware` が主要な戦略で、会話がトークン閾値を超えると別のLLM呼び出しで旧メッセージをサマリーに変換する。現在メッセージは保持する。モデルルーティング（複雑な会話→大モデル、単純→効率モデル）も実施する。

### 主なイノベーション

- **コンテキストエンジニアリングの体系化**: Write/Select/Compress/Isolateという4戦略の明確な分類
- **グラフ状態機械**: LangGraphの状態はすべてのエージェントステップでチェックポイント化される（短期スクラッチパッドとして機能）
- **ミドルウェアパターン**: LLM呼び出しをラップするミドルウェアでコンテキスト注入・サマリー・ガードを実現

---

## 2. AutoGen (Microsoft)

**Confirmed**

### プロンプト構造

AutoGen v0.4はアクターモデルに基づく非同期メッセージパッシングシステムである。

```
[System Message]
  - エージェントロール定義
  - 基本的な行動指針

[Memory System Message] ← メモリが有効な場合に挿入
  "Relevant memory content (in chronological order):
   1. [メモリエントリ1]
   2. [メモリエントリ2]"

[Conversation History]
  - BaseChatMessage継承メッセージ（source・タイムスタンプ・usage含む）

[Current Task]
```

### コンテキストウィンドウ管理

AutoGenはモジュラーなメモリアーキテクチャを採用する。

- **ListMemory**: シンプルなリストベースの実装。時系列順でメモリを保持し、最新のメモリをモデルコンテキストに追加する。
- **Vector Store Memory**: ベクトルDBベースのRAGパターンをサポート。
- **カスタムMemory**: `Memory` プロトコルを実装することで独自実装が可能。

```python
# Memory protocolの5操作
add()         # 新情報の保存
query()       # 関連エントリの取得
update_context()  # モデルコンテキストへの注入（SystemMessageとして挿入）
clear()       # 全エントリ削除
close()       # リソース解放
```

`AssistantAgent` は最後のメッセージでメモリをクエリし、結果を `update_context` でエージェントの内部 `model_context` に挿入する（`SystemMessage` として追加）。

### マルチエージェント会話構造

AutoGenの会話フローはイベント駆動で非同期である。

- **イベント駆動フロー**: リアクティブエージェントがイベントに応答
- **リクエスト/レスポンスパターン**: エージェントが同期的に相互呼び出し
- **Actor Model**: 各エージェントが独立したアクターとして機能し、メッセージ経由で通信

### メモリ注入の形式

```
SystemMessage(content='Relevant memory content (in chronological order):\n1. [entry]\n2. [entry]')
```

メモリエントリはコンテキストウィンドウの早い位置（Systemメッセージ）に配置される。

### 主なイノベーション

- **Actor Model採用**: v0.4でのアーキテクチャ刷新。スケーラビリティと柔軟性を大幅改善。
- **AgentChat API**: 迅速なプロトタイピング向けのシンプルな高レベルAPI
- **Semantic Kernelとの統合**: 2025年にMicrosoft Agent Frameworkとして統合予定

---

## 3. CrewAI

**Confirmed**

### プロンプト構造

CrewAIのエージェントはタスク受信時に以下の流れでプロンプトを構成する。

```
[Agent Role & Goal]
  - agentのrole, goal, backstoryから構成

[Task Description]
  - タスクの目的・期待出力

[Contextual Memory Injection] ← メモリ有効時
  - 関連するメモリの想起・注入（スコアベース選択）

[Reasoning Plan] ← reasoning有効時
  - 現在のタスク目標の反省
  - 構造化された実行計画の作成・注入

[Available Tools]
  - 使用可能なツール一覧
```

### メモリシステム

CrewAIはUnified Memory Systemを採用し、従来の個別メモリタイプ（short-term/long-term/entity/external）を単一の `Memory` クラスに統合した。

**メモリ保存時の処理**:
1. LLMがコンテンツを分析してscope（`/project/alpha` のようなファイルシステム的パス）を推定
2. categories（例: "architecture", "database"）を自動付与
3. importance スコア（0-1）を設定

**メモリ想起の複合スコアリング**:
```
score = semantic_weight × similarity + recency_weight × decay + importance_weight × importance
```
- semantic_weight: 意味的類似度
- recency_weight: 時間減衰
- importance_weight: 重要度タグ

### コンテキスト管理

```python
# Retrieval depth control
memory.retrieve(query, depth="shallow")  # 通常のエージェントコンテキスト
memory.retrieve(query, depth="deep")    # 複雑なクエリ向けLLM駆動分析
```

- タスク完了後、クルーは自動的にタスク出力から個別の事実を抽出してメモリに保存
- 全エージェントはクルーのメモリを共有（エージェント固有メモリも設定可能）

### 動的コンテキスト

- **Query Rewriting**: エージェントが元のプロンプトをナレッジベース検索に最適化された形に変換
- **Non-blocking saves**: エージェントが実行を続けながらバックグラウンドでメモリを符号化

### 主なイノベーション

- **有機的な構造形成**: スコープツリーがデータから自然発生的に構築される
- **複合スコアリング**: 類似性・再近性・重要度の3要素バランス
- **自動事実抽出**: タスク出力から自動的にメモリ保存

---

## 4. OpenAI Agents SDK

**Confirmed**

### プロンプト構造

OpenAI Agents SDKは以下の構造でエージェントを定義する。

```python
agent = Agent(
    name="...",
    instructions="...",  # system prompt（静的文字列 or 動的関数）
    tools=[...],
)
```

`instructions` パラメータがシステムプロンプトとして機能する。動的関数を使う場合:

```python
def dynamic_instructions(context: RunContextWrapper[MyContext], agent: Agent) -> str:
    return f"User: {context.context.user_name}. Today: {datetime.now()}"
```

### コンテキスト管理

OpenAI Agents SDKは2種類のコンテキストを明確に区別する。

**1. LLMに見えるコンテキスト（agent instructions経由）**:
- 静的または動的に計算されたinstructions
- Runner.run()経由で渡されたmessages
- ツール結果（tool resultsは会話履歴に自動追加）

**2. ローカルコンテキスト（LLMには不可視）**:
- `RunContextWrapper[T]` を通じてツール・コールバック・ライフサイクルフックからアクセス可能
- 依存性注入パターン: データベース接続、設定、ユーザー情報等

### セッションメモリとコンテキスト管理

**Context Trimming（直近N件保持）**:
```python
session = TrimmingSession("id", max_turns=3)
```
- 会話履歴を後方から走査してN番目のユーザーメッセージ以降を保持
- ゼロレイテンシ、ただし長期コンテキストを失う

**Context Summarization（要約による圧縮）**:
```python
session = SummarizingSession(keep_last_n_turns=2, context_limit=4, summarizer=LLMSummarizer(client))
```
- turn数が閾値超過時に古い会話を合成サマリーペアに変換
- サマリーペア: `[user: "Summarize...", assistant: "{generated_summary}"]`
- その後に最新N件を付加

**サマリー構造（推奨形式）**:
```
## Product & Environment
## Reported Issue
## Steps Tried & Results
## Identifiers
## Timeline Milestones
## Tool Performance Insights
## Current Status & Blockers
## Next Recommended Step
```

### トークンバジェット

`wrapper.usage` で現在のrun全体のトークン使用量（リクエスト横断の集計）を追跡可能。GPT-5のコンテキストウィンドウは272kトークン（入力）+ 128k（出力）。

### 主なイノベーション

- **依存性注入パターン**: コンテキストオブジェクトが全エージェント・ツール・ハンドオフで共有される
- **Session抽象化**: Trimming/Summarizingのどちらの戦略も同じinterfaceで切り替え可能
- **高精度なサマリー設計**: 矛盾チェック・UNVERIFIED表記・エラーコードの引用保持等

---

## 5. DSPy

**Confirmed**

### 概念

DSPyは「プロンプティングではなく、プログラミング」というパラダイム転換を提唱する。プロンプト文字列を手動でチューニングするのではなく、入出力の**署名（Signature）**と**モジュール**で宣言的にAIの振る舞いを定義し、**オプティマイザー**が自動的にプロンプトを最適化する。

### アーキテクチャ（3層）

**1. Signature（入出力署名）**:
```python
# インライン形式
"question -> answer"
"context: list[str], question: str -> answer: str"

# クラスベース形式（型制約付き）
class Emotion(dspy.Signature):
    """Classify emotion."""
    sentence: str = dspy.InputField()
    sentiment: Literal['sadness', 'joy'] = dspy.OutputField()
```

**2. Module（実行戦略）**:
- `dspy.Predict`: 基本的なLM呼び出し
- `dspy.ChainOfThought`: `reasoning` フィールドを自動追加（CoT）
- `dspy.ReAct`: ツール使用を含むReActパターン
- カスタムモジュール: 複数モジュールを合成したパイプライン

**3. Optimizer（プロンプト最適化）**:

| オプティマイザー | 手法 |
|----------------|------|
| **MIPROv2** | データ認識・デモンストレーション認識の命令生成。ベイズ最適化で命令+デモの最適組み合わせを探索 |
| **COPRO** | 各ステップの命令を生成・精製、座標上昇（hill-climbing）で最適化 |
| **SIMBA** | 確率的ミニバッチサンプリングで困難な例を特定し、失敗からself-reflective改善ルールを生成 |
| **GEPA** | プログラム軌跡を反省し、何が効いて何が効かなかったかを特定してプロンプトを改善 |
| **KNNFewShot** | 入力と類似したデモンストレーションをk-NNで動的選択 |

### 実際のプロンプト構造（コンパイル後）

DSPyがSignatureをコンパイルすると、概ね以下の構造のプロンプトが生成される。

```
[Task Instructions]
  ← オプティマイザーが生成した最適命令

[Few-shot Examples] ← オプティマイザーが選択した良質な例
  Input: ...
  Reasoning: ...
  Output: ...

  Input: ...
  Reasoning: ...
  Output: ...

[Current Input]
  Field1: {value}
  Field2: {value}

[Output Fields]
  Reasoning: ...  ← ChainOfThought使用時
  Answer: ...
```

### 主なイノベーション

- **プロンプトのコード化**: プロンプトを可変パラメータとして扱い、最適化の対象にする
- **メトリクス駆動の自動改善**: 評価メトリクスさえ定義すれば全モジュールのプロンプトを自動最適化
- **ポータビリティ**: モデル変更時もSignatureを保持したまま再コンパイルすれば最適化される

---

## 6. Semantic Kernel (Microsoft)

**Confirmed**

### プロンプトテンプレート構文

Semantic Kernelは独自テンプレート言語（`{{$variable}}`）に加え、Handlebars・Liquidのテンプレートエンジンをサポートする。

```
# 変数注入
Hello {{$name}}, welcome to Semantic Kernel!

# 関数呼び出し
The weather today is {{weather.getForecast}}.

# パラメータ付き関数呼び出し
The weather in {{$city}} is {{weather.getForecast $city}}.
```

**YAMLによるエージェント定義**:
```yaml
name: GenerateStory
template: |
  Tell a story about {{$topic}} that is {{$length}} sentences long.
template_format: semantic-kernel
description: A function that generates a story about a topic.
input_variables:
  - name: topic
    is_required: true
  - name: length
    is_required: true
```

### エージェントメモリシステム

**Mem0 Integration**:
- スレッドに追加された各メッセージはMem0サービスへ送信されてメモリを抽出
- 各エージェント呼び出し時に、ユーザーリクエストに合致するメモリをMem0に問い合わせ
- マッチしたメモリはエージェントコンテキストに追加される
- ユーザーID・スレッドID・エージェントID・アプリIDでメモリをスコープ可能

**Whiteboard Memory（短期コンテキスト保持）**:
- 会話中の各メッセージから要件・提案・決定・アクションを抽出してホワイトボードに保存
- 各呼び出し時にホワイトボード内容を追加コンテキストとして提供
- チャット履歴がトリミングされても重要な意思決定を保持

```csharp
// ContextPrompt: メモリの意味を説明するプレフィックス
// MaintenancePromptTemplate: ホワイトボード更新用プロンプト（カスタマイズ可能）
var whiteboardProvider = new WhiteboardProvider(chatClient);
agentThread.AIContextProviders.Add(whiteboardProvider);
```

### 動的 vs 静的コンテキスト

- **静的**: `instructions` パラメータ（エージェント作成時に固定）
- **動的**: テンプレートパラメータで実行時に値を差し込む。`KernelArguments` で上書き可能

### 主なイノベーション

- **YAML定義**: エージェント定義をコードから分離し設定として管理
- **AIContextProvider**: メモリプロバイダーをスレッドにアタッチする拡張可能なDIパターン
- **Whiteboard**: 会話履歴がトリミングされても重要な情報を保持する仕組み

---

## 7. Claude / MCP (Anthropic)

**Confirmed**

### プロンプト構造とコンテキストエンジニアリング原則

Anthropicは「コンテキストエンジニアリング」を「LLM推論中にどのトークンの設定が望ましい振る舞いを最も引き出せるかの問いに答えること」と定義する。

**Anthropic推奨のSystem Prompt構造**:
```
<background_information>
  [エージェントの役割・背景]
</background_information>

<instructions>
  [具体的な行動指針 — 高度なレベルで記述、ブリットルなロジックを避ける]
</instructions>

## Tool guidance
  [ツールの使い方の指針]

[代表的な例 — エッジケースの網羅ではなく多様性重視]
```

原則: 「言わずに多く意味する（say less, mean more）」。必要最小限の情報で期待する振る舞いを完全に記述する。

### コンテキスト管理戦略

**Just-in-Time データ取得**:
- データを事前ロードするのではなく、実行時に動的にロード
- ファイルパス・URL・クエリなどの軽量IDを渡し、エージェントがツールで取得
- メタデータ（フォルダ階層・命名規則・タイムスタンプ）を行動の手がかりとして活用

**長期タスク向け3戦略**:
1. **Compaction**: 会話履歴をサマリー化し、圧縮されたコンテキストで再初期化（重要な設計判断は保持）
2. **Structured Note-taking**: エージェントがコンテキストウィンドウ外に永続ノートを書く（進捗トラッカー・戦略情報）
3. **Sub-Agent Architecture**: 特定タスクに集中した専門エージェントが個別コンテキストを持ち、1000-2000トークンの凝縮サマリーをコーディネーターに返す

**コンテキスト劣化（Context Rot）の防止**:
- Context Poisoning: ハルシネーションがコンテキストに入り込む
- Context Distraction: コンテキストがトレーニングデータを圧倒する
- Context Confusion: 余分なコンテキストがレスポンスに影響する
- Context Clash: 矛盾する情報が混在する

### MCP (Model Context Protocol)

MCPは「AIアプリケーションと外部システムをつなぐオープンスタンダード」。

- **プロトコルベースの持続的コンテキスト**: 入力・ツール出力・中間状態を複数インタラクションにわたって追跡
- **Tool Result Clearing**: ツール結果が使用済みになったら生の出力を履歴から削除（コンパクション）
- **プロンプトインジェクション防止**: RL訓練でClaude自体に防御能力を組み込み。悪意あるコンテンツに埋め込まれたインジェクションを検出・拒否するよう報酬を設計

### Agent Skills System

スキルはインストラクション・スクリプト・リソースのフォルダで、Claudeが動的に発見してロードできる「プロフェッショナル知識パック」。プロンプト展開とコンテキスト修正によって機能し、実行可能コードを書かずにClaudeの処理を修正する。

### 主なイノベーション

- **Tool Result Clearing**: 消費済みツール結果の自動クリアによるコンテキスト節約
- **Progressive Disclosure**: サマリーから始めてエージェントが必要に応じてドリルダウン
- **RL-based Injection Defense**: プロンプトインジェクション防御をモデル訓練に組み込み

---

## 8. Voyager / GITM / Generative Agents

**Confirmed**（研究論文系）

### 8.1 Voyager（Wang et al. 2023）

Minecraftでの生涯学習エージェント。3コンポーネント構成:

**コンポーネント**:
1. **自動カリキュラム**: GPT-4が「できる限り多様なことを発見する」という目標に基づきタスクを生成。探索進捗・エージェント状態を考慮。
2. **スキルライブラリ（長期メモリ）**: 実行可能なコードとしてスキルを保存。スキル説明の埋め込みベクトルでインデックス化。類似状況で検索可能。
3. **反復プロンプト機構**: コード生成のための3種フィードバック統合:
   - 環境フィードバック（必要リソースの不足検出）
   - 実行エラー（誤ったツール製作等の修正）
   - 自己検証（GPT-4が批評者として目標達成度を評価）

**メモリ → プロンプトパイプライン**:
```
新タスク受信
↓
スキルライブラリから埋め込みベースで上位5件のスキルを検索
↓
検索結果をプロンプトに注入（コードとして）
↓
コード生成 → 実行 → フィードバック → 反復
↓
成功時: 新スキルをライブラリに追加
```

**コンテキスト構造（各反復）**:
```
[Retrieved Skills] ← 上位5件の関連スキル（コード）
[Current Task]
[Environment State]
[Previous Attempt Results] ← エラー・フィードバック
```

### 8.2 GITM（Ghost in the Minecraft、2023）

3層LLM階層によるMinecraftエージェント:

**階層構造**:
```
LLM Decomposer
  ├── インターネットから収集したテキスト知識をもとにgoal→sub-goalsに分解
  └── キーバリュー構造（自然言語キー + 埋め込みベクトル値）

LLM Planner
  ├── 各sub-goalに対して構造化アクション列を計画
  └── 成功したアクション列をテキストメモリに記録・要約

LLM Interface
  └── 構造化アクションをキーボード/マウス操作に変換
```

**メモリ注入**: LLM Plannerが過去の成功事例をプランニングプロンプトに文脈例として注入する（テキストベースin-context learning）。

### 8.3 Generative Agents（Park et al. 2023）

仮想社会のシミュレーション。人間らしい振る舞いを持つエージェント。

**Memory Stream（記憶ストリーム）**:
各エントリには{テキスト内容, 作成日時, 最終アクセス日時}を含む。

**3要素複合スコアリング（検索時）**:
```
score = normalize(recency) + normalize(importance) + normalize(relevance)
```
- **Recency**: 最終アクセス時刻からの指数減衰
- **Importance**: LLMが1-10でスコアリング（歯磨きは1、離婚は9）
- **Relevance**: クエリ-メモリ間のcosine類似度（埋め込みベース）

**プロンプト構造**:
```
[Agent Situation] ← 現在の状況
[Retrieved Memories] ← スコアリングで選択した記憶
[Action Query]
```

**Reflection（反省）機構**:
- 直近100件の記憶のimportanceスコア合計が閾値を超えたとき（1日2-3回）に発火
- LLMが最も顕著な100件の記憶から問いを生成
- その問いに答える形でinsightを生成 → 高レベルメモリとして保存
- Reflectionは「2次メモリ」として通常の記憶と同様に検索可能

**主なイノベーション**:
- **tri-factor retrieval**: 再近性+重要度+関連性の3要素バランス検索
- **Reflection**: 記憶から自動的に高次洞察を生成するメカニズム
- **プロンプト内での記憶制限**: 選択した記憶がプロンプト制約内に収まるよう調整

---

## 9. MemGPT / Letta

**Confirmed**

### アーキテクチャ概念

MemGPTは「LLMをオペレーティングシステムとして」というメタファーで設計される。仮想メモリの概念をLLMコンテキスト管理に適用。

### 3層メモリアーキテクチャ

```
┌─────────────────────────────────────────────┐
│         Main Context（メインコンテキスト）         │
│  ┌─────────────────────────────────────────┐ │
│  │ System Instructions + Function Defs    │ │
│  ├─────────────────────────────────────────┤ │
│  │ Core Memory                            │ │
│  │   - Persona Block（エージェントの人格）    │ │
│  │   - Human Block（ユーザー情報）           │ │
│  ├─────────────────────────────────────────┤ │
│  │ Conversation History（FIFO Queue）      │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
            ↕ Function Calls（ページング）
┌─────────────────────────────────────────────┐
│         External Context（外部コンテキスト）       │
│  ┌──────────────────┐ ┌───────────────────┐ │
│  │ Recall Storage   │ │ Archival Storage  │ │
│  │ (会話履歴全体:    │ │ (無限容量ナレッジ: │ │
│  │  テキスト検索可) │ │  埋め込み検索)    │ │
│  └──────────────────┘ └───────────────────┘ │
└─────────────────────────────────────────────┘
```

### ページング関数（LLMが直接呼び出す）

LLMが**自分で**コンテキスト管理を行う。6つの主要関数:

```
send_message(content)          ← ユーザーへの唯一の通知手段
core_memory_append(field, content)  ← コアメモリへの追記
core_memory_replace(field, old, new)  ← コアメモリの更新
conversation_search(query, page)  ← リコールストレージから検索
archival_memory_insert(content)  ← アーカイブへの書き込み
archival_memory_search(query, page)  ← アーカイブからの検索
```

### コンテキスト管理のユニークな点

- **LLM自律管理**: コンテキスト容量が逼迫するとLLMが自発的にページアウトを実行
- **inner monologue**: LLMの内部推論は50語以内のinner monologueとして機能（ユーザーに不可視）
- **FIFO Queue**: 会話履歴は先入れ先出しで管理。あふれると外部に移動
- **ペルソナ定着**: 「自分のペルソナに完全に浸透せよ」という強力なシステム指示

### Letta（MemGPTの後継フレームワーク）

MemGPTのエージェントデザインパターンをOSSフレームワークとして実装。長期的・持続的なエージェントのための開発基盤。マルチエージェントコラボレーションもサポート。

### 主なイノベーション

- **OS仮想メモリのアナロジー**: page in/outによるコンテキスト管理
- **LLM主体のメモリ管理**: エージェントが自分のコンテキスト状態を能動的に管理
- **階層化アーキテクチャ**: core/recall/archivalの明確な役割分担

---

## 10. Reflexion / LATS

**Confirmed**

### 10.1 Reflexion

Reflexionは言語的フィードバックによってLLMエージェントを強化するフレームワーク。

**3コンポーネント構成**:
1. **Actor**: CoTやReActでテキスト・アクションを生成。メモリコンポーネントを持つ。
2. **Evaluator**: Actorの出力をスコアリング。タスク固有の報酬関数を使用。
3. **Self-Reflection**: 報酬信号・軌跡・持続的メモリから言語的強化キューを生成するLLM。

**プロンプトへの言語的フィードバック注入**:
```
エピソードi:
  [Task Definition]
  [Long-term Memory: past_reflections] ← 蓄積された過去の内省
  [Current Attempt]
  → [Result] → [Evaluator Score]
  → [Self-Reflection: "what went wrong and how to improve"]
  → long-term memoryに追加

エピソードi+1:
  [Task Definition]
  [Long-term Memory: past_reflections (updated)]  ← 更新された内省を注入
  [New Attempt]
```

**2種類のメモリ**:
- **Short-term**: 現在の軌跡（評価用）
- **Long-term**: エピソード横断で蓄積される内省と経験

### 10.2 LATS（Language Agent Tree Search）

LATSはReflexion・Tree of Thoughts・ReActを統合し、Monte Carlo Tree Search（MCTS）をLLMエージェントに適用した汎用フレームワーク。ICML 2024採択。

**6操作サイクル**:
```
Selection → Expansion → Evaluation → Simulation → Backpropagation → Reflection
```

**Hybrid Value Function**:
```
V(s) = λ × LM(s) + (1-λ) × SC(s)
```
- LM(s): 軌跡正確度のLM評価スコア
- SC(s): 同一状態での行動頻度（自己一貫性スコア）
- λ: 推論タスク=0.5, 行動タスク=0.8

**UCT（探索-活用バランス）**:
```
UCT(s) = V(s) + w√(ln N(p) / N(s))
```

**Reflection（失敗軌跡の記憶化と注入）**:
```
失敗ノード到達時:
  → 軌跡 + 最終報酬でLMをプロンプト
  → 誤りと代替案を要約したself-reflectionを生成
  → [失敗軌跡, reflection]をメモリに保存

次のイテレーション:
  → 保存した失敗+reflectionをエージェントと価値関数の追加コンテキストとして注入
  → in-context learningによって両者を改善
```

**4種類のタスク固有プロンプト**:
- Acting prompts（環境認識行動生成）
- Reasoning prompts（内部思考生成）
- Value function prompts（状態品質評価）
- Reflection prompts（エラーサマリー生成）

**主なイノベーション**:
- **MCTS × LLM**: 「テキストを貼り付けることで任意の状態に戻れる」という特性を利用し、世界モデル学習不要のMCTS実装
- **Semantic Gradient**: スカラー報酬の代わりに言語的フィードバックで学習
- **動的Few-shot**: 失敗reflectionが逐次的にプロンプトのfew-shot例として蓄積

---

## 11. 共通パターンの抽出

### パターン1: プロンプトの階層構造（全システム共通）

ほぼ全フレームワークが以下の構造を採用する:

```
[System/Instruction Layer]  ← 静的 or ゆっくり変わる（エージェント定義）
[Memory/Context Layer]      ← 動的に選択・更新（メモリ・ナレッジ）
[Conversation History]      ← 管理・圧縮の対象
[Current Input/Task]        ← 即時入力
[Tool Results]              ← 実行フィードバック
```

### パターン2: メモリの階層化（hot/warm/cold/archival）

| 層 | 常にコンテキストに | 検索でページイン | 外部保存 |
|----|--------------------|-------------------|---------|
| Core / Working | ✓ | — | — |
| Short-term / Episodic | 部分的 | ✓ | — |
| Long-term / Semantic | — | ✓（RAG） | ✓ |
| Archival | — | ✓（埋め込み） | ✓ |

### パターン3: メモリ検索の複合スコアリング

Generative AgentsのRetrievalスコアが最も精緻だが、CrewAIも類似のアプローチ:

```
retrieval_score = f(semantic_similarity, recency_decay, importance_score)
```

単純なセマンティック検索だけでは「最近の重要な情報」を見落とす。

### パターン4: コンテキスト圧縮戦略

全主要フレームワークが以下の組み合わせを採用:

| 戦略 | 手法 | トレードオフ |
|------|------|------------|
| Trimming | 古いメッセージを削除 | ゼロレイテンシ、長期コンテキスト消失 |
| Summarization | LLMで要約 | レイテンシあり、情報圧縮ロス |
| Tool Result Clearing | 使用済みツール結果を削除 | クリーンだが再参照不可 |
| Sub-Agent Isolation | 専門エージェントが個別コンテキスト | 高品質、オーバーヘッドあり |

### パターン5: 動的 vs 静的コンテキスト

| 静的（常にある） | 動的（条件付き選択） |
|-----------------|-------------------|
| エージェントロール定義 | 検索されたメモリ |
| 基本的な行動規則 | ツール実行結果 |
| ペルソナ・人格 | ユーザー設定情報 |
| セキュリティ制約 | 関連知識 |

### パターン6: LLM自律型 vs システム管理型

- **LLM自律型**（MemGPT）: LLM自身が関数呼び出しでメモリを管理。柔軟だが予測困難。
- **システム管理型**（LangGraph・CrewAI）: フレームワークがルールベースでコンテキストを管理。予測可能だが硬直的。
- **ハイブリッド**（LATS・Reflexion）: システムが軌跡収集、LLMが内省生成、システムが注入。

### パターン7: Reflection/Self-Critique

Reflexion・LATS・DSPy(SIMBA/GEPA)・CrewAIのreasoning全てが「過去の失敗から学ぶ」メカニズムを持つ。
- 失敗 → 言語的内省生成 → 次回試行時にコンテキストとして注入
- スカラー報酬ではなく**言語的フィードバック**による学習

---

## 12. ベストプラクティスのまとめ

### プロンプト設計

1. **XMLタグ/Markdownヘッダーで構造化する**: `<instructions>`, `<background>`, `## Tool guidance` など。LLMが参照しやすくなる（Anthropic推奨）。

2. **適切な抽象高度で記述する**: 具体的すぎてブリットルになる vs 曖昧すぎて無効になるのバランスを取る。「例は千の言葉に値する」（多様な正例 > エッジケースの網羅）。

3. **静的/動的を明確に分離する**: 変わらない定義はシステムプロンプト、変わるコンテキストは動的注入。

4. **ツール説明は自己完結・非重複・目的特定に**: ツール説明はそれ自体がプロンプトの一部。曖昧な説明はエラーの原因になる。

### コンテキスト管理

5. **Just-in-Time取得**: データを事前ロードせず、エージェントがツールで動的取得。軽量IDを渡す。

6. **4戦略を状況に応じて組み合わせる**: Write（保存）/ Select（選択）/ Compress（圧縮）/ Isolate（分離）

7. **サマリーには構造を持たせる**: 「何が解決済みで何が未解決か」「重要な決定事項」「次のステップ」を明示的に含める。UNVERIFIEDタグで不確実情報を明示。

8. **トークンバジェットを計測する**: 会話の成熟度によってシステムプロンプトの長さが変動する（例: 2000-4050トークン）。各セクションへの割り当てを設計する。

### メモリシステム

9. **複合スコアリングで検索する**: semantic similarity単体ではなく recency + importance + relevance の複合スコアで検索する。

10. **Reflection機構を設ける**: タスク失敗後に「何が間違っていたか」を言語化し、次回試行のコンテキストに含める。

11. **メモリの階層を明確に分離する**: core（常時コンテキスト）/ recall（検索でページイン）/ archival（埋め込み検索）の役割を決める。

12. **メモリ保存時にメタデータを付与する**: scope・category・importance・timestampがないと精度の高い検索ができない。

### マルチエージェント

13. **Sub-agent isolationで長期タスクを処理する**: 専門エージェントが個別コンテキストを持ち、凝縮サマリー（1000-2000トークン）を上位に返す。

14. **Actor Modelで非同期を扱う**: AutoGenのv0.4アーキテクチャが示すように、イベント駆動+アクターモデルがスケーラブル。

---

## 13. Motivaへの示唆

Motivaは `hot → warm → cold → archival` の階層メモリを持つAIエージェントオーケストレーターである。以下に各研究知見をMotiva固有の問題に対応させる。

### 示唆1: ObservationEngineのプロンプト構造を体系化する

現状、`observeWithLLM()` のプロンプトはワークスペースコンテキストの注入が不十分（memory bug #4）。Anthropicの推奨に従って構造化する:

```
<background>
  Goal: {goal.description}
  Current dimensions: {dimensions}
  Previous observations: {recent_observations}  ← warm層から取得
</background>

<workspace_context>
  {just-in-time取得したワークスペース状態}  ← datasourceで動的取得
</workspace_context>

<instructions>
  Observe progress objectively. Return scores for each dimension.
</instructions>
```

### 示唆2: メモリ検索に複合スコアリングを導入する

現在のhot→warm→cold→archivalは「階層」は定義されているが、検索スコアリングが単純なはず。Generative AgentsのTri-factor retrievalを参考に:

```typescript
retrievalScore(memory: MemoryEntry, query: string): number {
  const recency = Math.exp(-decayFactor * timeSinceLastAccess(memory));
  const importance = memory.importanceScore; // 0-1
  const relevance = cosineSimilarity(embed(query), memory.embedding);
  return normalize(recency) + normalize(importance) + normalize(relevance);
}
```

これにより「最近アクセスされた重要なメモリ」が「昔の高スコアメモリ」より優先される。

### 示唆3: Gap計算とTask生成プロンプトにhot/warm層を体系的に注入する

現状のbuildTaskGenerationPrompt()はworkspace stateが欠落（memory note参照）。LangGraphの4戦略フレームワークを適用:

- **Select**: hot層から現在ゴール状態、warm層から直近の観測・タスク結果を注入
- **Compress**: cold層は要約してから注入（LLM呼び出しコストとトークンのトレードオフ）
- **Isolate**: archival層はベクトル検索で関連知識のみ取得（全件注入は禁物）

```typescript
async buildEnrichedTaskPrompt(goal: Goal): Promise<string> {
  // hot: 常にある
  const currentState = await hotMemory.get(goal.id);

  // warm: 直近N件
  const recentObs = await warmMemory.getRecent(goal.id, { n: 5 });

  // cold: LLMサマリー
  const coldSummary = await coldMemory.getSummary(goal.id);

  // archival: セマンティック検索
  const relevantKnowledge = await archivalMemory.search(goal.description, { topK: 3 });

  return buildPrompt({ currentState, recentObs, coldSummary, relevantKnowledge });
}
```

### 示唆4: Reflexion型の内省メカニズムをCoreLoopに統合する

タスク失敗（L1失敗・L2失敗・stall検出）の後に言語的内省を生成し、次のTask生成コンテキストに含める:

```
失敗後の処理:
  1. 失敗軌跡（試みたタスク・観測結果・エラー）をまとめる
  2. LLMに「何が間違っていたか・次は何を試すべきか」を問う
  3. 生成されたreflectionをwarm層に保存（importance=0.9）
  4. 次のTask生成時にreflectionをプロンプトに含める
```

これによりMotivaのループが単なる観測→ギャップ→タスク→実行→検証の繰り返しから、**失敗から学ぶ自己改善ループ**に進化する。

### 示唆5: プロンプトテンプレートの外部化（Semantic Kernel参考）

現在Motivaのプロンプトはコード内にハードコードされている。YAMLテンプレートとして外部化することで:

- モデル変更時の再最適化が容易
- 非エンジニアでも調整可能
- バージョン管理・A/Bテストが可能

```yaml
# prompts/task-generation.yaml
name: TaskGeneration
template: |
  <goal>{{$goal_description}}</goal>
  <gap>{{$gap_analysis}}</gap>
  <context>{{$hot_memory}}</context>
  <recent_observations>{{$warm_memory}}</recent_observations>
  <knowledge>{{$archival_snippets}}</knowledge>
  {{$reflections}}
  Generate the next task to close the gap.
```

### 示唆6: MemGPTのコアメモリ概念をGoalContextに適用する

MemGPTのcore memory（ペルソナ/ユーザーの固定ブロック）に対応するものとして、Motivaにおける**ゴールコアコンテキスト**を定義する:

```
Goal Core Context（常にhot層にある固定情報）:
  - goal.description
  - goal.thresholds（min/max/target値）
  - goal.constraints（制約条件）
  - goal.currentState（最新スナップショット）
  - goal.activeStrategy（現在の戦略）
```

これらは毎回のLLM呼び出しに必ず含まれる。warm以下のメモリはページイン/ページアウトの対象となる。

### 示唆7: DSPy的な「プロンプトの自動最適化」の将来展望

現在のMotivaプロンプトは手動チューニングに依存している。将来的にはDSPy的アプローチを適用できる:

- ゴール達成率をメトリクスとして定義
- 各LLM呼び出し（ObservationEngine・TaskGeneration・GapCalculation）をSignatureとして定義
- BootstrapFewShot + MIPROv2でプロンプトを自動最適化

ただし、これはMotiva自体が多数のゴール実行データを蓄積してから意味をなす（Phase 3以降の話）。

### 示唆8: コンテキスト劣化（Context Rot）防止

Motivaの長期ループでは以下のContext Rot問題が生じる可能性がある:

- **Context Poisoning**: 誤った観測値がコンテキストに入り込み、後続のTask生成を誤らせる
- **Context Confusion**: 無関係な古い知識がTask生成の精度を下げる

対策:
1. 観測値に**confidence**フラグを付け（UNVERIFIEDに相当）、確信度低い情報を明示
2. archival層への検索はクエリに強い関連性制約を設ける（cosine similarity閾値 >= 0.7等）
3. 長期ループ後に定期的なコンパクション（cold層のサマリー再生成）を実行

---

## 参照ソース

- [LangChain Context Engineering Docs](https://docs.langchain.com/oss/python/langchain/context-engineering)
- [LangChain Context Engineering Blog](https://blog.langchain.com/context-engineering-for-agents/)
- [AutoGen Memory Docs](https://microsoft.github.io/autogen/stable//user-guide/agentchat-user-guide/memory.html)
- [CrewAI Memory Docs](https://docs.crewai.com/en/concepts/memory)
- [OpenAI Agents SDK Context Docs](https://openai.github.io/openai-agents-python/context/)
- [OpenAI Agents SDK Session Memory Cookbook](https://developers.openai.com/cookbook/examples/agents_sdk/session_memory)
- [DSPy Official Site](https://dspy.ai/)
- [DSPy Signatures](https://dspy.ai/learn/programming/signatures/)
- [Semantic Kernel Prompt Template Syntax](https://learn.microsoft.com/en-us/semantic-kernel/concepts/prompts/prompt-template-syntax)
- [Semantic Kernel Agent Memory](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-memory)
- [Semantic Kernel Agent Templates](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-templates)
- [Anthropic Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic Claude Context Engineering Secrets](https://01.me/en/2025/12/context-engineering-from-claude/)
- [Voyager Paper](https://arxiv.org/abs/2305.16291)
- [Voyager Site](https://voyager.minedojo.org/)
- [GITM Paper](https://arxiv.org/abs/2305.17144)
- [GITM GitHub](https://github.com/OpenGVLab/GITM)
- [Generative Agents Paper (ACM)](https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763)
- [MemGPT Paper](https://arxiv.org/abs/2310.08560)
- [Letta Docs](https://docs.letta.com/concepts/letta/)
- [MemGPT Blog](https://www.leoniemonigatti.com/blog/memgpt.html)
- [Reflexion Prompt Engineering Guide](https://www.promptingguide.ai/techniques/reflexion)
- [LATS Paper](https://arxiv.org/abs/2310.04406)
- [LATS HTML](https://arxiv.org/html/2310.04406v3)
