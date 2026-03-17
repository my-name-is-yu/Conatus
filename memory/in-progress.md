# In-Progress

## 現在: Dogfooding第2ラウンド完了

rawモード(`goal add --title --dim`)でdogfooding検証完了。

### 今セッション完了
- **gap=0即completed修正** (a927850): gap=0でタスク生成スキップ + completionJudgment.is_complete=true
- **Dogfooding全パス検証済み**:
  - tsc_error_count:min:0 → gap=0, 1iter completed ✅
  - todo_count:min:0 → gap=0, 1iter completed ✅
  - multi-dim (tsc+test_count) → gap=0, 1iter completed ✅
  - test_coverage:min:90 → gap=2.00, 2iter max_iterations ✅ (LLMフォールバック動作)
  - test_count:min:5000 → gap=0.12, 2iter completed ✅

### 発見した改善点（今後の候補）
- **タスク品質**: test_count:5000で「541個の空ファイル追加」という低品質タスクを生成 → LLMプロンプト改善が必要
- **検証精度**: 2iter目でgap=0判定されたが実際にテストが増えたか不明 → 検証ステップの信頼性
- **@vitest/coverage-v8未インストール**: test_coverageパターンのShellDataSourceが常に失敗 → 依存問題（バグではない）

### 未解決・要観察（前セッションから継続）
- サブゴール品質（tree mode）→ プロンプト圧縮で改善したが未再検証
- GitHub Issueゴール — GitHubIssueAdapter検証未実施

### 残タスク
- plugin CLI実装（`src/cli/commands/plugin.ts` — ルーティングのみ追加済み、本体未実装）
- Milestone 13（`docs/roadmap-m8-beyond.md` §13）
