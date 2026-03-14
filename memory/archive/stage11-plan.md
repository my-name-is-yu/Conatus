---
name: Stage 11 実装プラン
description: Stage 11（好奇心・倫理・キャラクター）を3フェーズに分割した実装計画
type: project
---

# Stage 11 実装プラン — 好奇心・倫理・キャラクター

**ビジョン対応**: 4. 正直な交渉 / 5. 自律的知識獲得（MVPレベル）
**前提**: Stage 9完了（Stage 10と並行可能）
**テーマ**: 「指示されたことを実行する」→「やるべきことを自ら発見する」への進化

---

## Phase 11A: 倫理ゲート Layer 1 + タスク手段チェック

**Why:** 好奇心がゴールを自動生成する前に、安全弁を先に整備する。好奇心なしで倫理ゲートだけ動かしても意味があり、リスクも低い。

### 実装内容

1. **EthicsGate Layer 1 — カテゴリベースブロックリスト**
   - 設計: `docs/design/goal-ethics.md` §4 Layer 1, §9 Phase 2
   - 意図レベルの分類ルール（6カテゴリ: 違法行為、加害、プライバシー侵害、欺瞞、セキュリティ侵害、差別自動化）
   - LLM不要の高速フィルター（Layer 2 LLM判定の前段に配置）
   - jailbreak耐性（ハードコードなのでプロンプトで書き換え不可）

2. **TaskLifecycle.generateTask() の手段チェック統合**
   - 設計: `docs/design/goal-ethics.md` §5
   - `checkMeans()` の実装（Stage 8でFIXMEコメントのみだった部分）
   - タスクの実行手段・副作用・データアクセス範囲をチェック
   - 目的OKでも手段NGならflag/reject

3. **ユーザーカスタマイズ可能な追加制約**
   - 設計: `docs/design/goal-ethics.md` §9 Phase 2
   - 組織固有のポリシー定義（`ethics_constraints` 設定）
   - ゴールレベル/タスク手段レベルの制約を設定ファイルで定義可能に

### 対象ファイル（想定）
- `src/ethics-gate.ts` — Layer 1追加、checkMeans()実装
- `src/types/ethics.ts` — Layer 1ルール型、カスタム制約型（新規）
- `src/task-lifecycle.ts` — checkMeans()統合
- `tests/ethics-gate.test.ts` — Layer 1テスト追加
- `tests/task-lifecycle.test.ts` — 手段チェックテスト追加

### 完了基準
- Layer 1が6カテゴリの意図分類でreject/pass判定できる
- checkMeans()がタスク生成後の手段チェックを実行する
- ユーザー定義のカスタム制約が適用される
- Layer 1 → Layer 2の2層パイプラインが動作する

---

## Phase 11B: キャラクターカスタマイズ + 満足化 Phase 2

**Why:** 好奇心の前に、既存機能の拡張を完了させる。キャラクターと満足化はどちらも既存モジュールの改善であり、新概念の導入が少ない。

### 実装内容

1. **キャラクターカスタマイズ — 4軸パラメータ調整**
   - 設計: `docs/design/character.md` §6 Phase 2
   - 4軸パラメータ:
     - `caution_level`: 保守的 ↔ 野心的（feasibility閾値調整）
     - `stall_flexibility`: 超柔軟 ↔ 粘り強い（エスカレーション閾値調整）
     - `communication_directness`: 配慮的 ↔ 直接的（代替案提示省略可否）
     - `proactivity_level`: 有事のみ ↔ 詳細（通常ループの詳細度）
   - 構造的制約との分離保証テスト（キャラクターパラメータが倫理ゲート・不可逆操作ルールに波及しないことを検証）
   - `motiva config character` サブコマンド

2. **満足化 Phase 2（部分）— 集約マッピング全種対応**
   - 設計: `docs/design/satisficing.md` §7 Phase 2
   - 集約マッピング全種対応: `min` / `avg` / `max` / `all_required`
   - サブゴール → 上位ゴールの次元伝播ロジック
   - 注: 意味的類似度による自動マッピング提案はStage 12に回す

### 対象ファイル（想定）
- `src/types/character.ts` — キャラクター設定型（新規）
- `src/character-config.ts` — パラメータ管理、デフォルト値、バリデーション（新規）
- `src/goal-negotiator.ts` — caution_level適用
- `src/stall-detector.ts` — stall_flexibility適用
- `src/reporting-engine.ts` — proactivity_level / communication_directness適用
- `src/satisficing-judge.ts` — 集約マッピングロジック追加
- `src/cli-runner.ts` — `config character` サブコマンド追加
- テスト: 各モジュールのテストファイル + 分離保証テスト

### 完了基準
- 4軸パラメータが設定・永続化・読み込みできる
- 各パラメータが対応モジュールの判断に反映される
- 分離保証テスト: キャラクターパラメータの変更が構造的制約に影響しないことを検証
- 集約マッピング4種がサブゴール→上位ゴール伝播で正しく動作する

---

## Phase 11C: 好奇心メカニズム MVP

**Why:** Stage 11の核心。Phase 11A（倫理ゲート強化）が安全弁として先に動いていることが前提。好奇心ゴールも倫理チェックを通過する必要がある。

### 実装内容

1. **CuriosityEngine — 5つの発動条件**
   - 設計: `docs/design/curiosity.md` §2
   - タスクキュー空（SatisficingJudge連動）
   - 予測外の観測（ObservationEngine連動、標準偏差2倍以上の乖離）
   - ドメイン内の繰り返し失敗（StallDetector連動、§2.3/§2.4のみ）
   - Goal Reviewerが未定義問題を発見（SessionManager goal_review連動）
   - 定期探索（デフォルト72時間、DriveSystem スケジュール連動）

2. **好奇心ゴール生成と承認フロー**
   - 設計: `docs/design/curiosity.md` §3, §6
   - origin: "curiosity" フィールド追加（既存Goal型を拡張）
   - 承認フロー: 提案 → ユーザー通知 → 承認/拒否
   - ゴールツリーへの挿入（Advisor正規化経由）
   - 自動クローズ条件（閾値達成、非生産的Nループ、スコープ外）

3. **学習フィードバックによる方向づけ**
   - 設計: `docs/design/curiosity.md` §4
   - 高インパクトドメイン優先（改善比率ベース）
   - 失敗パターンからの再構成提案
   - クロスゴール転移（MVP: dimension_name完全一致）
   - 盲点検出（MVP: LLMヒューリスティック、detection_method: "llm_heuristic"）

4. **リソース予算・制約**
   - 設計: `docs/design/curiosity.md` §5
   - ユーザーゴール優先（絶対ルール）
   - 同時提案数上限（デフォルト3）
   - 自動失効（未承認12時間、非生産的3ループ）
   - スコープ制約（現在のゴール群から1ステップ隣接まで）
   - リソース予算（アクティブゴールあり→最大20%）

5. **CoreLoop統合**
   - 好奇心チェックをループサイクルに組み込み
   - 好奇心ゴールのタスク発見ループへの接続

### 対象ファイル（想定）
- `src/curiosity-engine.ts` — 新規: 発動条件評価、ゴール生成、学習フィードバック
- `src/types/curiosity.ts` — 新規: CuriosityGoal型、CuriosityConfig型
- `src/types/goal.ts` — origin フィールド追加（"user" | "curiosity"）
- `src/core-loop.ts` — 好奇心チェック統合
- `src/drive-system.ts` — 定期探索スケジュール
- テスト: `tests/curiosity-engine.test.ts`（新規）、core-loop/drive-system テスト追加

### 完了基準
- 5つの発動条件がそれぞれ正しくトリガーする
- 好奇心ゴールが生成・提案・承認/拒否・失効できる
- 学習フィードバック4パターンが方向づけに反映される
- リソース予算制約が遵守される
- CoreLoopに統合され、通常ループ内で好奇心が動作する

---

## フェーズ間の依存関係

```
Phase 11A (倫理ゲート強化)
    │
    ├── Phase 11B (キャラクター + 満足化) ← 11Aと並行可能
    │
    └── Phase 11C (好奇心MVP) ← 11Aが前提（好奇心ゴールの倫理チェック）
                               ← 11Bは前提ではないが、先に完了が望ましい
```

**推奨実装順序**: 11A → 11B → 11C
- 11Aと11Bは技術的には並行可能だが、ファイル競合を避けるため順次実装を推奨
- 11Cは11A完了が必須（好奇心ゴールが倫理チェックを通過する必要がある）

---

## 見積もり

| Phase | 新規ファイル | 変更ファイル | テスト規模 |
|-------|------------|------------|-----------|
| 11A | 1-2 | 3-4 | ~80テスト |
| 11B | 2-3 | 4-5 | ~100テスト |
| 11C | 2-3 | 3-4 | ~120テスト |
| **合計** | **5-8** | **10-13** | **~300テスト** |
