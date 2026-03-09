# Motiva (motive-layer) 使用ガイド

個人用PoC開発者向け実践ガイド。

---

## 1. セットアップ

### ビルド

```bash
cd /Users/yuyoshimuta/Documents/dev/Motiva
npm install
npm run build        # TypeScript → dist/ にコンパイル
```

ビルド後に `dist/cli.js`、`dist/hooks/*.js` が生成される。

### 動作確認

```bash
node dist/cli.js --help
node dist/hooks/session-start.js < /dev/null   # 空の stdin で起動テスト
```

### 対象プロジェクトへのインストール

**方法A: npm link（開発中の推奨）**

```bash
# Motiva ディレクトリで
cd /Users/yuyoshimuta/Documents/dev/Motiva
npm link

# 対象プロジェクトのルートで
cd /path/to/your-project
npm link motive-layer

# 確認
motive --version    # bin が通れば OK
```

**方法B: 直接パス指定（npm link 不要）**

hook コマンドに `node /Users/yuyoshimuta/Documents/dev/Motiva/dist/hooks/xxx.js` を直接書く（後述の settings.json 例を参照）。

### motive init — 初期化

対象プロジェクトのルートで実行する。

```bash
cd /path/to/your-project
motive init
# または -p で明示指定
motive init -p /path/to/your-project
```

作成されるファイル:

```
your-project/
└── .motive/
    ├── state.json          # セッション状態・信頼残高
    └── goals/              # ゴール個別ファイル (*.json)
    # log.jsonl と config.yaml は最初の使用時に自動生成
```

`.gitignore` に `.motive/` を追加しておくこと。

---

## 2. Claude Code Hooks 設定

対象プロジェクトの `.claude/settings.json` に以下を追記する。

### 完全な設定例（直接パス指定版）

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "MOTIVE_PROJECT_ROOT=/path/to/your-project node /Users/yuyoshimuta/Documents/dev/Motiva/dist/hooks/session-start.js"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "MOTIVE_PROJECT_ROOT=/path/to/your-project node /Users/yuyoshimuta/Documents/dev/Motiva/dist/hooks/user-prompt.js"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "MOTIVE_PROJECT_ROOT=/path/to/your-project node /Users/yuyoshimuta/Documents/dev/Motiva/dist/hooks/pre-tool-use.js"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "MOTIVE_PROJECT_ROOT=/path/to/your-project node /Users/yuyoshimuta/Documents/dev/Motiva/dist/hooks/post-tool-use.js"
          }
        ]
      }
    ],
    "PostToolFailure": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "MOTIVE_PROJECT_ROOT=/path/to/your-project node /Users/yuyoshimuta/Documents/dev/Motiva/dist/hooks/post-tool-failure.js"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "MOTIVE_PROJECT_ROOT=/path/to/your-project node /Users/yuyoshimuta/Documents/dev/Motiva/dist/hooks/stop.js"
          }
        ]
      }
    ]
  }
}
```

### MOTIVE_PROJECT_ROOT 環境変数

各 hook スクリプトは `MOTIVE_PROJECT_ROOT` が設定されていない場合 `process.cwd()` を使う。Claude Code がどのディレクトリで hook を起動するかは保証されないため、**常に明示的に設定すること**。

### 各フックイベントと対応 JS ファイル

| イベント名 | JSファイル | タイムアウト目安 |
|-----------|-----------|----------------|
| `SessionStart` | `session-start.js` | <200ms |
| `UserPromptSubmit` | `user-prompt.js` | <300ms |
| `PreToolUse` | `pre-tool-use.js` | <300ms |
| `PostToolUse` | `post-tool-use.js` | <300ms |
| `PostToolFailure` | `post-tool-failure.js` | <300ms |
| `Stop` | `stop.js` | <300ms |

### stdin JSON 形式

各フックは stdin から JSON を受け取る。

| フック | stdin フィールド |
|--------|---------------|
| `SessionStart` | `{ "session_id"?: string, "cwd"?: string }` |
| `UserPromptSubmit` | `{ "prompt": string }` |
| `PreToolUse` | `{ "tool_name": string, "tool_input": object }` |
| `PostToolUse` | `{ "tool_name": string, "tool_input"?: object, "tool_output"?: string }` |
| `PostToolFailure` | `{ "tool_name": string, "error"?: string }` |
| `Stop` | `{ "session_id"?: string, "stop_reason"?: string }` |

空または不正な JSON が来た場合はデフォルト値で処理を続行する（クラッシュしない）。

---

## 3. ゴール設定

### add-goal コマンドの構文

```bash
motive add-goal \
  --title "ゴールのタイトル" \
  --description "詳細な説明" \
  --type deadline|dissatisfaction|opportunity
```

オプション一覧:

| フラグ | 必須 | デフォルト | 説明 |
|-------|------|-----------|------|
| `-t, --title` | 必須 | — | ゴールタイトル |
| `-d, --description` | 任意 | `""` | 詳細説明 |
| `--type` | 任意 | `dissatisfaction` | 動機タイプ |
| `-p, --project` | 任意 | `cwd` | プロジェクトルート |

### ゴールの各フィールド（state.json / goals/*.json）

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `id` | string | 自動生成 (`goal-xxxxxxxx`) |
| `title` | string | ゴールタイトル |
| `description` | string | 詳細説明 |
| `type` | `deadline \| dissatisfaction \| opportunity` | 動機タイプ |
| `deadline` | string \| null | ISO 8601 形式の期限 |
| `status` | `active \| completed \| paused \| abandoned` | 現在の状態 |
| `motivation_score` | number | 優先度スコア（0〜1） |
| `state_vector` | object | 進捗・品質などの観測値マップ |
| `gaps` | array | 現在値 → 目標値のギャップリスト |
| `achievement_thresholds` | object | 完了判定の閾値（デフォルト: `progress >= 0.9`） |
| `constraints.max_subtasks` | number | サブタスク上限（デフォルト: 10） |
| `constraints.max_generation_depth` | number | タスク生成の深さ上限（デフォルト: 3） |
| `motivation_breakdown` | object | 動機スコアの内訳（session-start フックが自動計算） |
| `motivation_breakdown.deadline_pressure` | number | 締切圧力スコア（0〜1） |
| `motivation_breakdown.dissatisfaction` | number | 不満スコア（0〜1） |
| `motivation_breakdown.opportunity` | number | 機会スコア（0〜1） |
| `parent_goal_id` | string \| null | 親ゴールID（自動生成。ルートゴールは null） |
| `created_at` | string | 作成日時（ISO 8601、自動生成） |

### 具体的なゴール設定例

**例1: 締切駆動 — リリース準備**

```bash
motive add-goal \
  --title "v1.0 リリース準備完了" \
  --description "テスト全件パス、ドキュメント更新、パッケージ公開" \
  --type deadline
```

締切を付けたい場合は、生成された `.motive/goals/goal-xxxxxxxx.json` を直接編集して `"deadline": "2025-04-01T00:00:00Z"` を設定する。

**例2: 不満駆動 — コードの品質改善**

```bash
motive add-goal \
  --title "テストカバレッジ 80% 達成" \
  --description "engines/ の未テスト関数にユニットテストを追加する" \
  --type dissatisfaction
```

**例3: 機会駆動 — 探索的タスク**

```bash
motive add-goal \
  --title "MCP サーバー統合の調査" \
  --description "motive-layer を MCP サーバー経由で提供する実現可能性を調べる" \
  --type opportunity
```

---

## 4. 日常的な使い方

### セッション開始時（SessionStart フック）

Claude Code がセッションを開始すると自動的に `session-start.js` が実行される。

処理内容:
1. `.motive/` ディレクトリと `state.json` を初期化（既存なら読み込み）
2. アクティブゴールのギャップを再計算
3. 各ゴールの `motivation_score` と `motivation_breakdown` を更新・保存
4. `.claude/rules/motive.md` を生成・書き出し（≤500トークン）

`motive.md` の内容例:

```
# Motive Context

Trust: 0.70

## Session Focus: v1.0 リリース準備完了
Score: 0.82 | Type: deadline
Deadline: 2025-04-01T00:00:00Z
Gaps:
  - progress: 0.3→1.0 (70% gap, conf:50%)
Next: Increase progress toward v1.0 リリース準備完了
```

### プロンプト送信時（UserPromptSubmit フック）

ユーザーがプロンプトを送ると `user-prompt.js` が動く。

- プロンプトのキーワードとアクティブゴールのタイトル・説明を照合
- **関連ゴールあり**: プロンプト末尾にゴール状況と次タスクのコンテキストを付与して通過
- **関連ゴールなし + 通常モード**: トップゴールへのリマインダーを付与して通過
- **関連ゴールなし + strict モード**: exit code 2 でブロック（後述の config 参照）

### ツール使用時（PreToolUse / PostToolUse フック）

**PreToolUse** — ツール実行前に不可逆アクションをチェック。以下のパターンが検出されると exit code 2 でブロックされ、人間確認が必要になる。

| ブロックされるパターン | 例 |
|----------------------|-----|
| `git push` | `git push origin main` |
| `rm -rf` | `rm -rf dist/` |
| `curl -X POST/PUT/DELETE/PATCH` | API への書き込みリクエスト |
| `docker push` / `docker rm` | Docker 操作 |
| `npm publish` | パッケージ公開 |
| `deploy`（単語一致） | デプロイスクリプト |
| `DROP TABLE` | SQL 削除 |
| `DELETE FROM` | SQL 削除 |

Write/Edit ツールでのパストラバーサルもブロックされる。ただし条件は **絶対パス（`/` 始まり）かつ `..` を含む** パスのみ。相対パス（例: `../sibling/file.txt`）はブロックされない。

**PostToolUse** — ツール成功後に状態を更新。

- `Bash` でテストコマンド実行 → `quality_score` を 0.0 または 1.0 に更新
- `Write` / `Edit` → `progress` に +0.05 加算（最大 1.0）
- エラーパターン検出時 → `last_error` を記録
- 連続失敗カウンターをリセット（成功した場合）
- ゴールの進捗が `achievement_thresholds` を超えていれば `status = completed` に遷移

### 停滞検知（PostToolFailure フック）

ツールが失敗するたびに `post-tool-failure.js` が呼ばれ、連続失敗カウンターをインクリメント。閾値（デフォルト 3 回）を超えると停滞（stall）とみなし、stdout にリカバリメッセージを出力する。

```
[Motiva] Stall detected: "Bash" has failed 3 times consecutively.
Cause: repeated_failure. Recovery (switch_task): Try a different approach or tool.
```

リカバリタイプは状況に応じて以下の4種類が出力される:

| リカバリタイプ | 意味 |
|--------------|------|
| `investigate` | 根本原因を調査する |
| `escalate` | 人間にエスカレーションする |
| `redefine_goal` | ゴール定義を見直す |
| `switch_task` | 別のタスクに切り替える |

カウンターは `.motive/state.json` の `stall_state.consecutive_failures` に保存され、セッション間で引き継がれる。

### セッション終了時（Stop フック）

Claude Code がセッションを止めると `stop.js` が自動実行される。

処理内容:
1. 全アクティブゴールに対して最終ギャップ解析
2. 完了判定（satisficing）でスコアが閾値以上なら `status = completed`
3. `state.json` の `active_goal_ids` から完了ゴールを除去
4. `.motive/log.jsonl` にセッションサマリーを追記

---

## 5. CLI コマンド一覧

グローバルオプション: `-p, --project <path>` で対象プロジェクトを指定（省略時は `cwd`）。

### motive init

```bash
motive init
motive init -p /path/to/project
```

`.motive/` ディレクトリを作成し `state.json` を初期化する。既に存在する場合は何もしない。

出力例:
```
Initialized .motive/ in /path/to/project
Session: a1b2c3d4-...
```

### motive status

```bash
motive status
```

現在のセッション状態を表示する。

出力例:
```
Session: a1b2c3d4-e5f6-...
Trust: 0.70
Active goals: 2
  [goal-abc12345] v1.0 リリース準備完了 (score: 0.82, status: active)
  [goal-def67890] テストカバレッジ 80% 達成 (score: 0.45, status: active)
```

### motive goals

```bash
motive goals
```

全ゴール（active/completed/paused/abandoned）を一覧表示する。

出力例:
```
  ● [goal-abc12345] v1.0 リリース準備完了 (deadline)
  ✓ [goal-old00001] 初期セットアップ (dissatisfaction)
  ✗ [goal-old00002] 廃止されたタスク (opportunity)
```

アイコン: `●` active / `✓` completed / `⏸` paused / `✗` abandoned

### motive add-goal

```bash
motive add-goal --title "タイトル" --description "説明" --type dissatisfaction
```

新しいゴールを追加し、アクティブリストに登録する。

出力例:
```
Added goal: goal-abc12345 — タイトル
```

### motive log

```bash
motive log
```

`.motive/log.jsonl` の直近10件のエントリを表示する。

出力例:
```
  [2025-03-10T10:00:00Z] ? → ?
  [2025-03-10T10:01:00Z] ? → ?
```

**PoC 既知の制限**: CLIの `motive log` コマンドは `entry.action?.tool` と `entry.outcome` フィールドを参照するが、実際のログエントリは `event`、`tool_name`、`has_error` などの異なるフィールド名で書き込まれる。そのためツール名と結果が `?` で表示される。生ログを確認したい場合は直接 `cat .motive/log.jsonl` で参照すること。

### motive reset

```bash
motive reset
```

セッション状態（`session_id`、タイムスタンプ）をリセットする。**ゴールは削除されない**。信頼残高や停滞カウンターは保持される。ただし、保持の挙動は Zod のスプレッド+再パースによるものであるため、既存の `state.json` に未定義フィールドが存在していた場合はデフォルト値で上書きされる点に注意。

### motive gc

```bash
motive gc              # デフォルト: 30日以内のログを残す
motive gc --days 7     # 7日以内のログだけ残す
```

`.motive/log.jsonl` の古いエントリを削除する。

出力例:
```
Removed 142 old entries, kept 38.
```

---

## 6. 設定ファイル

### .motive/config.yaml

初回は自動生成されない。必要に応じて手動作成する。

```yaml
# .motive/config.yaml

# プロンプトがアクティブゴールに無関係な場合にブロックするか
# true にすると exit code 2 でブロック、false（デフォルト）はリマインダーのみ
strict_goal_alignment: false
```

現在 `user-prompt.js` が読み取るフィールドは `strict_goal_alignment` のみ。

### 設定可能な値とデフォルト一覧（models.ts より）

**GoalConstraints（ゴールごとの制約）**

| フィールド | デフォルト | 説明 |
|-----------|-----------|------|
| `max_generation_depth` | `3` | タスク生成の階層上限 |
| `max_subtasks` | `10` | サブタスク数の上限 |
| `distance_filter` | `0.7` | ギャップフィルタリングの閾値 |

**TrustBalance（信頼残高）**

| フィールド | デフォルト | 範囲 | 説明 |
|-----------|-----------|------|------|
| `global` | `0.7` | 0〜1 | グローバル信頼残高 |

変動ルール:
- ツール成功（通常）: +0.05
- ツール成功（不可逆アクション後）: +0.10
- ツール失敗（通常）: -0.15
- ツール失敗（不可逆アクション後）: -0.30

**MetaMotivation（好奇心エンジン）**

| フィールド | デフォルト | 説明 |
|-----------|-----------|------|
| `exploration_budget` | `3` | 探索可能なターゲット数 |
| `activation_conditions.idle_threshold_seconds` | `30` | アイドル検知の秒数 |
| `activation_conditions.anomaly_threshold` | `0.7` | 異常検知の閾値 |

**WarningThresholds（motive.md 警告表示）**

| 条件 | 警告メッセージ |
|------|--------------|
| `trust_balance.global < 0.4` | "Low trust balance — prefer reversible actions" |
| `stall_state.stall_count > 2` | "Stall detected — consider switching strategy" |

---

## 7. トラブルシューティング

### hook が動いていないように見える

1. `dist/` が存在するか確認: `ls /Users/yuyoshimuta/Documents/dev/Motiva/dist/hooks/`
2. ビルドし直す: `cd /Users/yuyoshimuta/Documents/dev/Motiva && npm run build`
3. `.claude/settings.json` のパスが正しいか確認（絶対パスを使うこと）
4. `MOTIVE_PROJECT_ROOT` が正しいプロジェクトルートを指しているか確認

### "No active goals" が出る

`motive status` でゴールが 0 件の場合は `motive init` がまだ走っていないか、goals が空。

```bash
motive init -p /path/to/your-project
motive add-goal --title "最初のゴール" --type dissatisfaction
motive status
```

### 信頼残高が低すぎる (trust < 0.4)

連続失敗が多い場合に下がる。手動でリセットするには `.motive/state.json` を直接編集する。

```json
{
  "trust_balance": {
    "global": 0.7,
    "per_goal": {}
  }
}
```

または `motive reset` でセッション状態を再生成する（trust は保持されるため、JSON 直接編集が確実）。

### 停滞カウンターをリセットしたい

`.motive/state.json` の `stall_state` を手動で初期化する:

```json
{
  "stall_state": {
    "consecutive_failures": {},
    "last_stall_at": null,
    "stall_count": 0
  }
}
```

### ログの確認方法

```bash
# 直近10件を表示
motive log

# 全件をそのまま見る（jsonl 形式）
cat /path/to/your-project/.motive/log.jsonl

# jq でイベント種別に絞る
cat /path/to/your-project/.motive/log.jsonl | jq -r 'select(.event == "post_tool_failure")'
```

### motive.md が更新されない

SessionStart フックが動いていない場合や `.motive/` が初期化されていない場合に起こる。

```bash
# 手動でセッション開始フックをテスト
echo '{}' | MOTIVE_PROJECT_ROOT=/path/to/your-project \
  node /Users/yuyoshimuta/Documents/dev/Motiva/dist/hooks/session-start.js

# 生成されたか確認
cat /path/to/your-project/.claude/rules/motive.md
```

### Claude Code の Hooks 設定を元に戻す（PoC 廃止時）

```bash
cp ~/.claude/settings.json.pre-motive ~/.claude/settings.json
cd /Users/yuyoshimuta/Documents/dev/Motiva && git checkout main
```

### テストの実行

```bash
cd /Users/yuyoshimuta/Documents/dev/Motiva
npx vitest run                       # 全テスト
npx vitest run tests/engines/        # エンジン系のみ
npx vitest run tests/hooks/          # フック系のみ
```
