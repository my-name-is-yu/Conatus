# Milestone 4.1 デーモンモード強化 — 調査結果

調査日: 2026-03-16

---

## Phase 2b 要件一覧（docs/runtime.md + docs/roadmap.md より）

### runtime.md §2 Phase 2b: cronエントリー生成

- `motiva cron` コマンドで crontab エントリーを出力する（デーモン不要ユーザー向け）
- 出力例:
  ```
  # Motivaを毎時実行するcrontabエントリー:
  0 * * * * /usr/local/bin/motiva run >> ~/.motiva/logs/cron.log 2>&1
  ```
- Phase 2bはPhase 2a（デーモン常駐）の代替。どちらも同じコアループを実行する

### roadmap.md §4.1 デーモンモード強化

1. **グレースフルシャットダウンとクラッシュリカバリの実装完成**
2. **状態復元**: プロセス再起動後に中断地点から再開
3. **ログローテーション**（サイズ/日付ベース）
4. **`motiva cron` コマンド**でcrontabエントリーを出力（デーモン不要ユーザー向け）

---

## 既存実装の概要

### src/daemon-runner.ts（328行）
**Confirmed**

クラス: `DaemonRunner`

| メソッド | 説明 |
|---|---|
| `constructor(deps: DaemonDeps)` | CoreLoop/DriveSystem/StateManager/PIDManager/Logger/Config注入 |
| `async start(goalIds: string[])` | デーモン起動、PID書き込み、runLoop呼び出し |
| `private async runLoop(goalIds)` | ループ本体（sleep + determineActiveGoals + CoreLoop.run） |
| `private determineActiveGoals(goalIds)` | DriveSystemのshouldActivate()でフィルタリング |
| `private getNextInterval(goalIds)` | goal_intervalsオーバーライドまたはcheck_interval_msを返す |
| `private handleLoopError(goalId, err)` | crash_count増加、max_retries超過でstop |
| `private handleCriticalError(err)` | クリティカルエラー時のstop |
| `private saveDaemonState()` | daemon-state.json をatomicWrite |
| `private loadDaemonState()` | daemon-state.json から復元 |
| `private cleanup()` | PIDファイル削除 |
| `private sleep(ms)` | Promise.resolve遅延 |
| `static generateCronEntry(goalId, intervalMinutes)` | crontabエントリー文字列生成（L365） |

**注意**: `start()` にはSIGTERM/SIGINTシグナルハンドラーが組み込まれているかどうかは未確認。stop()はcmdStopからprocess.killで呼ばれる（外部SIGNALベース）。

### src/pid-manager.ts（57行）
**Confirmed**

クラス: `PIDManager`
- `constructor(baseDir, pidFile?)` — デフォルトpidFile: `motiva.pid`
- `writePID()` — 現在のprocess.pidをJSON atomicWrite
- `readPID()` — PIDInfoSchemaでパースして返す（不正JSON→null）
- `isRunning()` — PIDファイルのPIDにシグナル0を送って生存確認
- `cleanup()` — PIDファイル削除（idempotent）

### src/logger.ts（93行）
**Confirmed**

クラス: `Logger`

設定インターフェース: `LoggerConfig`（dir, maxSizeMB, maxFiles, level, consoleOutput）

主要メソッド（publicはdebug/info/warn/errorの4つ）:
- `debug/info/warn/error(message, context?)` — レベルフィルタ → ファイル書き込み（+ console）
- `private log(level, message, context?)` — 共通書き込みロジック
- `private writeToFile(line)` — rotateIfNeeded → ファイルappend
- `private rotateIfNeeded()` — maxSizeBytes超過時にmotiva.N.logへリネーム

**現状**: 日付ベースローテーションは未実装（サイズベースのみ）。

### src/cli-runner.ts（1,644行）

デーモン関連コマンドの実装箇所:

| コマンド | メソッド | 行番号 |
|---|---|---|
| `motiva start` | `cmdStart()` | L775 |
| `motiva stop` | `cmdStop()` | L825 |
| `motiva cron` | `cmdCron()` | L847 |
| サブコマンドルーティング | `dispatch()` | L1660–L1671 |

`cmdCron()`の現状:
- `--goal <id>` と `--interval <min>`（省略時60分）を受け取る
- `DaemonRunner.generateCronEntry(goalId, intervalMinutes)` を呼ぶ
- `# Add these to your crontab with: crontab -e` のヘッダーつきで出力
- 複数goalIdに対応（ループ）

### src/types/daemon.ts（41行）

型定義:
- `DaemonConfigSchema`: check_interval_ms / pid_file / log_dir / log_rotation(max_size_mb, max_files) / crash_recovery(enabled, max_retries, retry_delay_ms) / goal_intervals
- `DaemonStateSchema`: pid / started_at / last_loop_at / loop_count / active_goals / status(running/stopping/stopped/crashed) / crash_count / last_error
- `PIDInfoSchema`: pid / started_at / version

---

## 既存テストカバレッジの概要

### tests/daemon-runner.test.ts（400行）— 32テスト
**Confirmed**

カバー済み:
- `constructor`: デフォルト設定値適用、部分オーバーライド（3テスト）
- `start()`: 重複起動拒否、PIDファイル書き込み、daemon-state.json保存、CoreLoop.run()呼び出し、shouldActivateフィルタリング、active_goals記録（6テスト）
- `stop()`: status=stopping書き込み、ループ終了+promiseリゾルブ、PIDファイル削除、status=stopped書き込み（4テスト）
- エラーハンドリング: crash_count増加、last_error記録、max_retries超過でstop（4テスト）
- `generateCronEntry()`: 間隔別パターン8種、goalId埋め込み（10テスト）
- daemon state persistence: daemon-state.jsonの場所、loop_count増加、pid値（3テスト）
- goal_intervals config（1テスト）
- cleanup: PIDファイル削除、.tmpファイル残留なし（2テスト）

**ギャップ**: グレースフルシャットダウン（SIGTERM受信シナリオ）、状態復元（再起動後の中断地点再開）のテストなし

### tests/pid-manager.test.ts（191行）— 21テスト
**Confirmed**

- constructor/getPath、writePID（atomic write含む）、readPID（null処理、JSON不正、round-trip）、isRunning（stale PIDファイル）、cleanup（idempotent）、edge cases（複数インスタンス干渉なし）を網羅

### tests/logger.test.ts（259行）— 20テスト
**Confirmed**

- constructor（ディレクトリ作成）、ファイル出力（各レベル、timestamp、context JSON）、レベルフィルタ（warn/info/error/debug）、console出力フラグ、ログローテーション（maxSizeMB超過、maxFiles制限、最古ファイル削除）を網羅

**ギャップ**: 日付ベースローテーション（roadmap要件）のテストなし

---

## 4.1で追加・変更が必要なファイルの推定リスト

### 1. src/daemon-runner.ts（変更）

要件: グレースフルシャットダウン、状態復元

追加が必要な機能:
- `start()` 内でSIGTERM/SIGINTを捕捉し、現在ループ完了後に安全停止するグレースフルシャットダウンフロー
- `loadDaemonState()` を利用した再起動後の状態復元（中断ゴールの特定と再開ロジック）
- `stop()` メソッドのpublic化または内部シグナル駆動停止フラグ（外部process.killでなく内部flagベース停止）

推定追加行数: **50–80行**

### 2. src/logger.ts（変更）

要件: 日付ベースのログローテーション追加

追加が必要な機能:
- `rotateIfNeeded()` に日付チェックロジック（前回書き込み日と異なればローテーション）
- `LoggerConfig` に `rotate_by_date: boolean` フィールド追加

推定追加行数: **20–30行**

### 3. src/types/daemon.ts（変更）

要件: 状態復元に必要なフィールド追加

追加が必要なフィールド:
- `DaemonStateSchema` に `interrupted_goals: string[]`（再起動後に再開すべきゴールID）
- `DaemonConfigSchema` に `graceful_shutdown_timeout_ms`（シャットダウン待機上限）

推定追加行数: **5–10行**

### 4. tests/daemon-runner.test.ts（変更）

新規テスト追加:
- グレースフルシャットダウン: SIGTERM受信 → ループ完了後に終了するシナリオ
- 状態復元: daemon-state.jsonにinterrupted_goalsがある状態でstart()すると再開される
- シャットダウンタイムアウト: 上限時間内に終了しない場合の強制停止

推定追加行数: **60–80行**（3–4テスト）

### 5. tests/logger.test.ts（変更）

新規テスト追加:
- 日付ベースローテーション: 前日のファイルを検出してローテーションするシナリオ

推定追加行数: **20–30行**（1–2テスト）

---

## 推定変更規模

| ファイル | 現在行数 | 追加推定 | 変更後推定 |
|---|---|---|---|
| src/daemon-runner.ts | 328 | +50〜80 | 380〜410 |
| src/logger.ts | 93 | +20〜30 | 113〜123 |
| src/types/daemon.ts | 41 | +5〜10 | 46〜51 |
| tests/daemon-runner.test.ts | 400 | +60〜80 | 460〜480 |
| tests/logger.test.ts | 259 | +20〜30 | 279〜289 |

**合計追加推定: 155〜230行**（Medium〜Multi-fileタスク規模）

---

## 調査ギャップ

- `cmdStop()` の現在実装が `process.kill(pid, 'SIGTERM')` を使っているかどうかは確認済み（L836-841）だが、DaemonRunner内部でSIGTERMハンドラーを登録しているか否かは未確認（コード詳細は未読）
- `generateCronEntry()` の出力形式に `motiva run --goal <id>` が含まれるかどうかの詳細は未確認（テストから想定）
- 日付ベースローテーションの設計（毎日0時 vs 書き込み時の日付変化検出）は設計判断が残る
- グレースフルシャットダウンの「中断地点から再開」の粒度（タスク単位? ループ単位?）は要設計判断
