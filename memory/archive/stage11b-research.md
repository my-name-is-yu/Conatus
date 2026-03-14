# Stage 11B Research — キャラクターカスタマイズ + 満足化 Phase 2

調査日: 2026-03-14
対象: `docs/design/character.md`, `docs/design/satisficing.md`, 関連ソース6ファイル, 型ファイル群

---

## 1. キャラクター4軸パラメータ

設計源: `docs/design/character.md` §3, §6

| パラメータ名 | 対応する軸 | デフォルト方向 | 範囲と型 | 影響先 |
|---|---|---|---|---|
| `caution_level` | 軸1: 現実の評価 | 保守的（低い値） | `number`, 提案: 1–5（1=保守的, 5=野心的） | GoalNegotiator の feasibility_ratio 閾値 |
| `stall_flexibility` | 軸2: 停滞時の判断 | 超・柔軟（低い値） | `number`, 提案: 1–5（1=超柔軟, 5=粘り強い） | StallDetector のエスカレーション閾値 (N ループ) |
| `communication_directness` | 軸3: 事実の伝達 | 配慮的かつ率直（中間） | `number`, 提案: 1–5（1=配慮的, 5=直接的） | ReportingEngine の代替案提示可否 |
| `proactivity_level` | 軸4: レポーティング | 有事のみ説明的（低い値） | `number`, 提案: 1–5（1=有事のみ, 5=常に詳細） | ReportingEngine の通常ループ詳細度 |

### デフォルト値（設計が示す「標準キャラクター」）

```typescript
const DEFAULT_CHARACTER_CONFIG = {
  caution_level: 2,         // 保守的よりやや内側（feasibility_ratio threshold = 2.5 相当）
  stall_flexibility: 1,     // 超・柔軟（3ループで即ピボット提案）
  communication_directness: 3,  // 配慮的かつ率直（代替案必ず添える）
  proactivity_level: 2,     // 有事のみ詳細（通常は1-2行サマリー）
};
```

### 各パラメータの具体的な影響値（設計文書から導出）

**caution_level → GoalNegotiator**
- character.md §3: `FEASIBILITY_RATIO_THRESHOLD_AMBITIOUS` のデフォルト = 2.5（通常は 3.0）
- caution_level=1（最保守）: ratio_threshold = 2.5
- caution_level=5（最野心的）: ratio_threshold = 3.5 程度（goal-negotiation.md の元定義3.0を上限として）
- 実装: `goal-negotiator.ts` の定数 `FEASIBILITY_RATIO_THRESHOLD_AMBITIOUS` (L25, 現在 2.5 固定) を `CharacterConfig.caution_level` から動的に算出

**stall_flexibility → StallDetector**
- character.md §3: 軸2は「第1検知（3ループ停滞）の時点でピボット提案」が超・柔軟
- stall_flexibility=1（超柔軟）: `FEEDBACK_CATEGORY_N.immediate = 3` → 即エスカレーション
- stall_flexibility=5（粘り強い）: N を大きく取る（例: immediate=5, medium_term=8, long_term=15）
- 実装: `stall-detector.ts` の `FEEDBACK_CATEGORY_N` 定数 (L7-11) を `CharacterConfig` から乗数で調整

**communication_directness → ReportingEngine**
- character.md §3: 軸3はネガティブレポートに「次のアクション候補」フィールドを必須とするかどうか
- directness=1（配慮的）: 代替案を常に添える（現在の実装は詳細なし → 追加が必要）
- directness=5（直接的）: 代替案省略可、事実のみ報告
- 実装: `reporting-engine.ts` の `generateNotification()` と `generateExecutionSummary()` に `CharacterConfig` を渡してトーン分岐

**proactivity_level → ReportingEngine**
- character.md §3: 軸4は通常ループを1-2行にとどめるか詳細を出すか
- proactivity=1（有事のみ）: 通常ループは1-2行、詳細はstall/escalation/completion時のみ
- proactivity=5（常に詳細）: 毎ループ詳細レポート
- 実装: `ReportingEngine.generateExecutionSummary()` に verbosity 制御フラグを追加

---

## 2. 満足化集約マッピング — 現在の実装 vs 追加が必要なもの

設計源: `docs/design/satisficing.md` §7

### 現在の実装（satisficing-judge.ts）

- `propagateSubgoalCompletion()` (L288): **名前一致による直接マッピングのみ**（MVP）
  - subgoalId と parentGoal.dimensions の名前を突き合わせ
  - 一致したらその次元の current_value を「充足値」にセット
  - `dimension_mapping` フィールドの存在チェックなし

### 追加が必要なもの（Phase 2）

設計文書が定義する集約マッピング4種:

| `aggregation` 値 | 意味 |
|---|---|
| `min` | サブゴール次元群の最小値を上位次元に反映 |
| `avg` | 平均値 |
| `max` | 最大値 |
| `all_required` | 全サブゴール次元が閾値を超えて初めて上位次元を完了扱い |

### データ構造（設計文書定義）

```typescript
// satisficing.md §7 のマッピング構造
dimension_mapping: {
  parent_dimension: string,       // 上位ゴールの次元名
  aggregation: "min" | "avg" | "max" | "all_required"
}
```

このフィールドは `src/types/goal.ts` の `Dimension` 型に追加する必要がある。現在の `Dimension` 型に `dimension_mapping` が存在するか確認が必要（GoalSchema にある `dimension_mapping: null` は Goal レベルのフィールドであり、Dimension レベルではない）。

### propagateSubgoalCompletion() の拡張ロジック

```
現在: subgoal完了 → parentGoal.dimensions から名前一致した1次元を充足値にセット

Phase 2:
  1. subgoal完了時に subgoal.dimensions 全体を持ってくる
  2. 各 subgoal.dimension の dimension_mapping.parent_dimension を参照
  3. 同じ parent_dimension を持つ複数のサブゴール次元を集約
  4. aggregation 種別に応じて: min(values), avg(values), max(values), all(>=threshold)
  5. 集約結果を parentGoal の該当次元 current_value にセット
```

---

## 3. 統合ポイント（各パラメータとコードのマッピング）

### 3.1 GoalNegotiator — caution_level

ファイル: `src/goal-negotiator.ts`

- **L24-27（定数ブロック）**: `FEASIBILITY_RATIO_THRESHOLD_REALISTIC = 1.5`, `FEASIBILITY_RATIO_THRESHOLD_AMBITIOUS = 2.5`
  - `caution_level` から `FEASIBILITY_RATIO_THRESHOLD_AMBITIOUS` を動的に算出するヘルパーを追加
- **L629-648（renegotiate内の quantitative path）**: `feasibilityRatio` と比較する際にキャラクターパラメータを使用
- **constructor**: `CharacterConfig` を DI で受け取る（または `CharacterConfigManager` から読み込む）
- **影響なし（倫理ゲートとの分離）**: L289 `this.ethicsGate.check()` はキャラクターパラメータに一切触れない

### 3.2 StallDetector — stall_flexibility

ファイル: `src/stall-detector.ts`

- **L7-11（FEEDBACK_CATEGORY_N）**: `{ immediate: 3, medium_term: 5, long_term: 10 }` を固定定数として持つ
  - `stall_flexibility` から各カテゴリの N を乗数で調整
  - 例: stall_flexibility=1 → N係数=1.0, stall_flexibility=5 → N係数=2.0
- **L13（DEFAULT_N = 5）**: これも `stall_flexibility` に連動させる
- **constructor**: `CharacterConfig` を DI で受け取る
- **影響なし（構造的制約）**: `CONSECUTIVE_FAILURE_THRESHOLD = 3` (L28), `ESCALATION_CAP = 3` (L29) は変更しない（安全フロア）

### 3.3 ReportingEngine — proactivity_level / communication_directness

ファイル: `src/reporting-engine.ts`

- **constructor (L37-47)**: `CharacterConfig` を第3引数として追加可能
- **generateExecutionSummary() (L51)**: `proactivity_level` に応じてコンテンツの詳細度を切り替え
  - proactivity=1: content を1-2行のサマリーに圧縮
  - proactivity=5: 現在の詳細フォーマットを維持（またはさらに詳細化）
- **generateNotification() (L399)**: `communication_directness` に応じてエスカレーション通知に代替案セクションを追加/省略
- **影響なし**: `saveReport()`, `listReports()`, `formatForCLI()` はキャラクター設定を参照しない

### 3.4 SatisficingJudge — 集約マッピング

ファイル: `src/satisficing-judge.ts`

- **propagateSubgoalCompletion() (L288-322)**: MVP→Phase 2 への拡張
  - 現在: 単一次元名一致 → 充足値をセット
  - Phase 2: `dimension_mapping` フィールドを参照し集約ロジックを実行
- **新メソッド追加候補**: `aggregateSubgoalDimensions(subgoalDimensions, parentDimension, aggregation)` — 純粋関数として実装可能

---

## 4. CLI統合 — `config character` サブコマンド

設計: stage11-plan.md § Phase 11B, character.md §6

### 既存サブコマンドのパターン（cli-runner.ts から）

```typescript
// 現在のパターン（L594-635）
if (subcommand === "goal") {
  const goalSubcommand = argv[1];
  if (goalSubcommand === "add") { ... }
  if (goalSubcommand === "list") { ... }
}
```

### 追加する `config` サブコマンド

```typescript
// 追加パターン
if (subcommand === "config") {
  const configSubcommand = argv[1];
  if (configSubcommand === "character") {
    // argv[2] 以降を parseArgs で解析
    // --caution-level <1-5>
    // --stall-flexibility <1-5>
    // --communication-directness <1-5>
    // --proactivity-level <1-5>
    // --reset (デフォルト値に戻す)
    // --show (現在の設定を表示)
  }
}
```

### 実装箇所

- `CLIRunner.run()` の dispatch ブロック (L550-713) に `config` ケースを追加
- `cmdConfigCharacter()` プライベートメソッドを追加
- `printUsage()` に `motiva config character` のヘルプを追加

---

## 5. 状態永続化パターン — CharacterConfig の保存

### StateManager のパターン（state-manager.ts から）

- **rawRead/rawWrite パターン (L207-219)**: 任意のパスに JSON をアトミック書き込み
  ```typescript
  this.stateManager.writeRaw("character-config.json", config);
  const raw = this.stateManager.readRaw("character-config.json");
  ```
- **atomicWrite** (L65-69): `.tmp` ファイル経由のリネームで安全な書き込み
- **パス**: `~/.motiva/character-config.json` が自然な配置

### CharacterConfigManager の設計

```typescript
export class CharacterConfigManager {
  private readonly stateManager: StateManager;

  load(): CharacterConfig {
    const raw = this.stateManager.readRaw("character-config.json");
    if (raw === null) return DEFAULT_CHARACTER_CONFIG;
    return CharacterConfigSchema.parse(raw);
  }

  save(config: CharacterConfig): void {
    const parsed = CharacterConfigSchema.parse(config);
    this.stateManager.writeRaw("character-config.json", parsed);
  }

  reset(): void {
    this.save(DEFAULT_CHARACTER_CONFIG);
  }
}
```

---

## 6. 分離保証テスト — 何をテストすべきか

設計: character.md §4, §6

### 分離保証が必要な境界

| テストケース | 検証内容 |
|---|---|
| `caution_level=5`（最野心的）でも ethicsGate.check() は verdict に変化なし | feasibility閾値緩和はキャラクター範囲内、ethics判定ロジック非接触を確認 |
| `stall_flexibility=5`（最粘り強い）でも不可逆操作の承認要求は省略されない | StallDetector の N 変化は CONSECUTIVE_FAILURE_THRESHOLD や ESCALATION_CAP に影響しない |
| `communication_directness=5`（最直接的）でも irreversible タスクの承認フローは変わらない | ReportingEngine のコンテンツ変化は TaskLifecycle の approvalFn に影響しない |
| `proactivity_level=1`（最静か）でも stall/escalation 時の詳細レポートは出力される | proactivity はデフォルトサマリー化のみ、重要イベントの詳細化は構造的制約 |

### テストファイル

- `tests/character-config.test.ts` — 新規: CharacterConfigManager の load/save/reset/validation
- `tests/character-separation.test.ts` — 新規: 分離保証テスト（4軸 × 境界ケース）
- `tests/goal-negotiator.test.ts` — 既存に追加: caution_level が feasibility 判定を変えるが ethics 判定を変えないことを検証
- `tests/stall-detector.test.ts` — 既存に追加: stall_flexibility が N を変えるが ESCALATION_CAP を変えないことを検証

---

## 7. 型パターン — 既存 Zod スキーマパターン

### 既存パターン（types/stall.ts, types/ethics.ts から）

```typescript
// パターン1: Enum + Schema + type
export const SomeEnum = z.enum(["a", "b", "c"]);
export type SomeType = z.infer<typeof SomeEnum>;

export const SomeSchema = z.object({
  field: SomeEnum,
  value: z.number().min(0).max(1),
  nullable_field: z.string().nullable().default(null),
});
export type Some = z.infer<typeof SomeSchema>;
```

### CharacterConfig 型の設計（新規: src/types/character.ts）

```typescript
import { z } from "zod";

// 1-5 のスケール（1=デフォルト方向, 5=反対方向）
const CharacterLevelSchema = z.number().int().min(1).max(5);

export const CharacterConfigSchema = z.object({
  caution_level: CharacterLevelSchema.default(2),
  stall_flexibility: CharacterLevelSchema.default(1),
  communication_directness: CharacterLevelSchema.default(3),
  proactivity_level: CharacterLevelSchema.default(2),
});
export type CharacterConfig = z.infer<typeof CharacterConfigSchema>;

export const DEFAULT_CHARACTER_CONFIG: CharacterConfig = CharacterConfigSchema.parse({});
```

### Dimension型への dimension_mapping 追加（src/types/goal.ts の DimensionSchema）

```typescript
// 現在の Dimension に追加するフィールド
dimension_mapping: z.object({
  parent_dimension: z.string(),
  aggregation: z.enum(["min", "avg", "max", "all_required"]),
}).nullable().default(null),
```

> **注意**: Goal レベルの `dimension_mapping: null` (GoalSchema) とは別物。
> Dimension レベルのフィールドとして追加する。

---

## 8. 現在のコードにおける Character MVP 実装の痕跡

設計が character.md に沿って既に実装されている部分:

- **GoalNegotiator L25**: `FEASIBILITY_RATIO_THRESHOLD_AMBITIOUS = 2.5` — character.md §3「2.5 にオーバーライドする」と一致（固定値として実装済み）
- **GoalNegotiator L26**: `REALISTIC_TARGET_ACCELERATION_FACTOR = 1.3` — character.md §3「余裕を1.3倍で取る」と一致
- **StallDetector L7**: `immediate: 3` — character.md §3「第1検知（3ループ）でピボット提案」と一致（超・柔軟デフォルト）
- **ReportingEngine L51-116**: `generateExecutionSummary()` は現在、常に詳細フォーマット（proactivity=5相当）— Phase 2でサマリーモード追加が必要

---

## 9. 新規ファイル / 変更ファイル 一覧

### 新規ファイル

| ファイル | 内容 |
|---|---|
| `src/types/character.ts` | CharacterConfigSchema, CharacterConfig型, DEFAULT_CHARACTER_CONFIG |
| `src/character-config.ts` | CharacterConfigManager クラス（load/save/reset, StateManager DI） |
| `tests/character-config.test.ts` | CharacterConfigManager の単体テスト |
| `tests/character-separation.test.ts` | 分離保証テスト（倫理ゲート・不可逆ルール非汚染） |

### 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `src/types/goal.ts` | DimensionSchema に `dimension_mapping` フィールド追加（nullable） |
| `src/goal-negotiator.ts` | constructor に CharacterConfig 追加, feasibility_ratio 閾値を caution_level から算出 |
| `src/stall-detector.ts` | constructor に CharacterConfig 追加, FEEDBACK_CATEGORY_N を stall_flexibility から乗数計算 |
| `src/reporting-engine.ts` | constructor に CharacterConfig 追加, proactivity/directness によるコンテンツ分岐 |
| `src/satisficing-judge.ts` | `propagateSubgoalCompletion()` に集約マッピング4種対応 |
| `src/cli-runner.ts` | `config character` サブコマンド追加, buildDeps() に CharacterConfigManager 追加 |
| `tests/goal-negotiator.test.ts` | caution_level による feasibility 変化テスト追加 |
| `tests/stall-detector.test.ts` | stall_flexibility による N 変化テスト追加 |
| `tests/reporting-engine.test.ts` | proactivity/directness によるコンテンツ差分テスト追加 |
| `tests/satisficing-judge.test.ts` | 集約マッピング4種テスト追加 |

---

## 10. ギャップと注意事項

1. **DimensionSchema の `dimension_mapping` フィールドの現状**: goal.ts を直接確認していない。Goal レベルには `dimension_mapping: null` が存在することは goal-negotiator.ts L432 から確認できたが、Dimension レベルに同フィールドがあるかは未確認。追加前に要確認。

2. **CharacterConfig の DI vs グローバル**: 各モジュール（GoalNegotiator, StallDetector, ReportingEngine）にキャラクター設定を渡す方法として DI（constructor 引数）とシングルトン（グローバル設定）がある。既存コードの DI パターン（StateManager, LLMClient, EthicsGate を全て constructor で受け取る）に合わせて DI が自然。

3. **ReportingEngine の「詳細レポートトリガー」**: character.md §3 軸4は「停滞/エスカレーション/完了/ピボット時は常に詳細」という構造的ルールを示す。`proactivity_level` が1であっても、これらのイベント時の詳細化は維持する必要がある（分離保証）。

4. **満足化 aggregation="avg" の実装**: `satisficing-judge.ts` は現在、次元の current_value を数値/文字列/boolean で扱う。avg 計算は numeric 前提なので、non-numeric 次元への fallback 処理が必要。

5. **stall_flexibility の最大値制御**: `ESCALATION_CAP = 3` は変更しない（安全フロア）。stall_flexibility=5 であっても、最終的なエスカレーションキャップは変えない。変えるのは「何ループで最初の stall を検知するか」のみ。
