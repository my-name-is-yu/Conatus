# In-Progress

## 前セッション完了（2026-03-18）

### コミット一覧
- `8a0a58c` fix: #23 event-server フレーキーテスト + #15 tie-breaker
- `00d9b9d` fix: #40 DoS, #41 パストラバーサル, #44 monotonic floor, #46 stalled
- `2338a79` fix: #42 counter-proposal dead code
- `6b52876` fix: #34-#38, #43, #45, #47（7件バグ修正）
- `8f667ed` fix: #39 Codex prompt stdin化
- `01480db` refactor: #60 makeTempDir 74ファイル統一
- `49654da` refactor: #61 makeGoal 28ファイル統一（-1017行）

### issueステータス（39件: #9,#11,#12,#15,#21-#62）
- バグ・セキュリティ: #34-#47（14件、**全件クローズ済み**）
- テスト品質: #60-#61（**クローズ済み**）、#62未着手
- その他クローズ: #15, #23
- コード品質: #48-#59（12件、オープン）
- ビジョン機能: #24-#33（10件、オープン）
- 未分類オープン: #9, #11, #12, #21, #22

---

## 次セッションでやるべきこと

### 優先度1: コード品質（High影響）
- **#51** JSON読み書き重複 → src/utils/json-io.ts
- **#48** sleep() 5ファイル重複 → src/utils/sleep.ts
- **#59** ~/.motiva パス構築散在 → src/utils/paths.ts
- **#55** catch握りつぶし一掃
- **#56** goal-negotiator 重複ブロック抽出
- **#57** core-loop God Method分割
- **#58** goal-tree-manager dead code削除

### 優先度2: テスト品質
- **#62** EthicsVerdict定数 9ファイル重複

### 優先度3: ビジョン機能
- **#24** 永続運用 cron/スケジューラ統合
- **#25** プロアクティブ通知
- **#26** 現実世界DataSource
- **#31** CLIコマンド: motiva plugin list/install/remove

### 未解決・要観察
- cli-runner-integration.test.ts タイムアウト（既存フレーキー）
- サブゴール品質（tree mode）→ #21
- GitHubIssueAdapter動作検証 → #22
