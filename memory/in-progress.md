# In-Progress: Milestone 4（永続ランタイム Phase 2）完了

## 完了済み

### M4.1 — デーモンモード強化
- グレースフルシャットダウン: SIGTERM/SIGINTハンドラー、ループ単位の安全停止、タイムアウト付き強制停止
- 状態復元: interrupted_goalsをdaemon-state.jsonに保存、再起動時にマージ復元
- 日付ベースログローテーション: 書き込み時検出方式、motiva.YYYY-MM-DD.logへリネーム
- 型拡張: DaemonStateSchema.interrupted_goals, DaemonConfigSchema.graceful_shutdown_timeout_ms
- レビュー指摘: sleep中のshutdown割り込み不可 → M4.2でAbortController対応により解決

### M4.2 — イベント駆動システム強化
- DaemonRunner ↔ EventServer統合（optional依存、start/stop連動）
- DaemonRunner ↔ DriveSystem.startWatcher統合（ファイルウォッチャー起動/停止連動）
- AbortController対応の中断可能sleep（イベント到着時に即座にループ再開）
- onEventReceived()メソッド追加（sleepAbortController.abort()でsleep中断）

### M4.3 — プッシュ報告強化
- Slack Webhook: 既存実装（Stage 10で完了）
- メールSMTP: nodemailerによる実SMTP送信実装（スタブから置換）
- DND: 既存実装（時間帯ベース、urgent_alert/approval_request例外）
- ゴール別設定オーバーライド: 既存実装
- Slackインタラクティブ承認: 将来対応（複雑なため後回し）

### M4.4 — 記憶ライフサイクルMVP
- **全MVP要件が既存実装（Stage 10）で完了済み**
- 3層記憶モデル: Working/Short-term/Long-term ディレクトリ構造+index.json
- Short-term保持期間管理: applyRetentionPolicy（ループ数ベース）
- Short→Long LLM圧縮: compressToLongTerm（パターン抽出・教訓蒸留）
- Working Memory選択: selectForWorkingMemory（タグ/次元マッチ）
- ガベージコレクション: runGarbageCollection（サイズ制限）
- 品質保証: validateCompressionQuality（失敗パターン保持確認）
- Phase 2残り: Drive-based管理、セマンティック検索（→ Milestone 5）

### 過去の完了
- R9 — 3+イテレーション反復改善 実Dogfooding（commit 9feb382）
- M3 Dogfooding再検証（commit af381fe）

## 現在の状態
- 2949テスト全パス（74ファイル）
- ブランチ: main

## 次のステップ: Milestone 5（意味的埋め込み Phase 2）
- 5.1: 知識獲得 Phase 2（ゴール横断共有ナレッジ、ベクトル検索）
- 5.2: 記憶ライフサイクル Phase 2（Drive-based管理、セマンティック検索）
- 5.3: セッション・コンテキスト Phase 2（動的バジェット、依存グラフ活用）
- ロードマップ: `docs/roadmap.md` Milestone 5セクション
- 設計ドキュメント: `docs/design/knowledge-acquisition.md`, `docs/design/memory-lifecycle.md`, `docs/design/session-and-context.md`
