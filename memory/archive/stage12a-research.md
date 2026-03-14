# Stage 12 Part A Research: 12.5 状態ベクトル Phase 2

**Status**: 調査完了
**対象ファイル**: 4ファイル変更（新規ファイルなし）

---

## 1. 現状確認（既に実装済みの内容）

### types/goal.ts — ほぼ実装済み (**Confirmed**)

`src/types/goal.ts` を確認したところ、Part A の主要型はすでに存在する：

- `GoalNodeTypeEnum` — `"goal" | "subgoal" | "milestone"` (**実装済み**, L91-92)
- `PaceSnapshotSchema` — `elapsed_ratio, achievement_ratio, pace_ratio, status, evaluated_at` (**実装済み**, L80-87)
- `GoalSchema` の milestone フィールド — `target_date, origin, pace_snapshot` (**実装済み**, L124-130)

`src/types/core.ts` には `PaceStatusEnum = z.enum(["on_track", "at_risk", "behind"])` も実装済み（L192-193）。

### types/state.ts — dimension_mapping 実装済み (**Confirmed**)

`DimensionSchema` に `dimension_mapping` フィールドが存在する（L59-66）：
```typescript
dimension_mapping: z.object({
  parent_dimension: z.string(),
  aggregation: SatisficingAggregationEnum,  // "min" | "avg" | "max" | "all_required"
}).nullable().default(null)
```

`SatisficingAggregationEnum` も `types/state.ts` で定義済み（L30-31）。

### satisficing-judge.ts — 集約マッピング全種実装済み (**Confirmed**)

Stage 11B で `propagateSubgoalCompletion()` に Phase 2 集約マッピング（min/avg/max/all_required）が実装済み（L294-432）。`aggregateValues()` 純粋関数も公開済み（L445-466）。

---

## 2. 未実装の内容（Part A で実装が必要なもの）

### state-manager.ts — マイルストーン追跡・ペース評価が完全に欠如 (**Confirmed**)

`src/state-manager.ts` に `milestone` という文字列は一切存在しない。以下のメソッドをすべて新規追加する必要がある：

**追加すべきメソッド（StateManager クラス）**:

```typescript
// マイルストーンノードの一覧取得（goal tree から）
getMilestones(rootId: string): Goal[]

// ペース評価の計算（純粋計算 + 保存）
evaluatePace(milestoneId: string): PaceSnapshot

// リスケジュール提案の生成（behind 時）
generateRescheduleOptions(milestoneId: string): RescheduleOptions

// マイルストーン期限チェック（期限超過したものを返す）
getOverdueMilestones(rootId: string): Goal[]

// マイルストーンへのペーススナップショット保存
savePaceSnapshot(milestoneId: string, snapshot: PaceSnapshot): void
```

**`evaluatePace()` の計算ロジック**（`state-vector.md` §8 より）:

```
elapsed_ratio = elapsed_time / total_time
achievement_ratio = current_achievement / target_achievement
pace_ratio = achievement_ratio / elapsed_ratio

if pace_ratio >= 1.0  → status = "on_track"
elif pace_ratio >= 0.7 → status = "at_risk"
else                  → status = "behind"

edge case: total_time == 0 → pace_ratio = 1.0, status = "on_track"
```

`current_achievement` は子ノードの集約達成度（SatisficingJudge 経由で取得）、`total_time` は `target_date - created_at`、`elapsed_time` は `now - created_at`。

**`generateRescheduleOptions()` の出力型（新規型、`types/state.ts` か `types/goal.ts` に追加）**:

```typescript
export const RescheduleOptionsSchema = z.object({
  milestone_id: z.string(),
  current_achievement_ratio: z.number(),
  pace_ratio: z.number(),
  options: z.array(z.object({
    type: z.enum(["extend_deadline", "reduce_target", "renegotiate_goal"]),
    description: z.string(),
    // extend_deadline: proposed new date
    proposed_target_date: z.string().nullable(),
    // reduce_target: proposed new threshold multiplier (e.g., 0.8 = 20% reduction)
    proposed_threshold_multiplier: z.number().nullable(),
  })),
  generated_at: z.string(),
});
export type RescheduleOptions = z.infer<typeof RescheduleOptionsSchema>;
```

### core-loop.ts — マイルストーン期限チェックの組み込みが未実装 (**Confirmed**)

`src/core-loop.ts` にはマイルストーン関連のコードが一切ない。

**最小限の組み込みポイント**: `runOneIteration()` の Step 5 (Completion Check) の直後（L512〜L527）。

```typescript
// ─── 5b. Milestone Deadline Check ───
// After completion check, check if any milestone is overdue and trigger pace evaluation.
if (goal.node_type !== "milestone") {
  // Only run at root/subgoal level, not inside milestone nodes themselves
  // StateManager.getOverdueMilestones() をここで呼ぶ
}
```

具体的には `runOneIteration()` の L526（`return result` の直前）と L529（stall check の前）の間に挿入する。非致命的（try/catch で wrap）。

**設計方針**: CoreLoop への組み込みは最小限。StateManager 内でペース評価を完結させ、CoreLoop はオーバーデュー検出と `LoopIterationResult` への記録のみ行う。

---

## 3. 型の追加場所

### `src/types/state.ts` への追加

`RescheduleOptions` 型を追加（L87 の `PaceSnapshot` 定義の直後）：

```typescript
// --- Reschedule Options (generated when milestone is "behind") ---

export const RescheduleOptionItemSchema = z.object({
  type: z.enum(["extend_deadline", "reduce_target", "renegotiate_goal"]),
  description: z.string(),
  proposed_target_date: z.string().nullable().default(null),
  proposed_threshold_multiplier: z.number().nullable().default(null),
});

export const RescheduleOptionsSchema = z.object({
  milestone_id: z.string(),
  current_achievement_ratio: z.number(),
  pace_ratio: z.number(),
  options: z.array(RescheduleOptionItemSchema),
  generated_at: z.string(),
});
export type RescheduleOptions = z.infer<typeof RescheduleOptionsSchema>;
```

### `src/types/goal.ts` — 変更不要 (**Confirmed**)

`"milestone"` は `GoalNodeTypeEnum` にすでに存在する。`target_date`, `origin`, `pace_snapshot` も `GoalSchema` に実装済み。

---

## 4. StateManager の現行 API と新メソッドの整合

現行 StateManager は以下のパターンで実装されている：
- ファイルレイアウト: `<base>/goals/<goal_id>/goal.json`, `<base>/goal-trees/<root_id>.json`
- Atomic write: `.tmp` ファイル経由 `rename()`
- 型安全: 全 read/write で Zod parse

マイルストーン関連の永続化は既存の `goal.json` に `pace_snapshot` フィールドとして格納（GoalSchema の一部）。`savePaceSnapshot()` は `loadGoal()` → update `pace_snapshot` → `saveGoal()` のパターンで実装できる。

リスケジュールオプションの永続化は `writeRaw("goals/<id>/reschedule-options.json", ...)` パターン（既存の `writeRaw` API を活用）。

---

## 5. LoopIterationResult への追加

`core-loop.ts` の `LoopIterationResult` インターフェース（L81-93）に以下フィールドを追加：

```typescript
// Milestone pace evaluation results (if any milestones were checked this iteration)
milestoneAlerts: Array<{
  milestone_id: string;
  pace_status: "on_track" | "at_risk" | "behind";
  pace_ratio: number;
}>;
```

---

## 6. テストパターン（`tests/state-manager.test.ts` より）

現行テストの構造：
- `makeTempDir()` → `fs.mkdtempSync()` でテスト用一時ディレクトリ
- `StateManager(tmpDir)` でインスタンス生成
- `beforeEach` / `afterEach` で `fs.rmSync(tmpDir, { recursive: true })` クリーンアップ
- `makeGoal(overrides)` ファクトリ関数で Goal オブジェクトを生成（**全フィールドを明示列挙**）
- `describe` → `it` の入れ子で機能別グループ化

**新テストで必要なシナリオ**（`tests/state-manager.test.ts` に追加）：

```
describe("Milestone Pace Evaluation", () => {
  it("evaluatePace returns on_track when pace_ratio >= 1.0")
  it("evaluatePace returns at_risk when 0.7 <= pace_ratio < 1.0")
  it("evaluatePace returns behind when pace_ratio < 0.7")
  it("evaluatePace handles total_time == 0 (returns on_track)")
  it("savePaceSnapshot persists snapshot to goal.json")
  it("getOverdueMilestones returns only milestones past target_date")
  it("getOverdueMilestones returns empty when no milestones are overdue")
  it("generateRescheduleOptions returns 3 options when behind")
  it("generateRescheduleOptions is not called when on_track")
})
```

---

## 7. ゴッチャ・注意事項

### 1. `SatisficingJudge` の循環依存に注意

`evaluatePace()` では `current_achievement` の計算に `SatisficingJudge.isGoalComplete()` または `computeActualProgress()` が必要。`StateManager` は `SatisficingJudge` に依存していないため、**StateManager 内で直接 SatisficingJudge を呼ぶのは NG**。

対応策: `evaluatePace(milestoneId: string, currentAchievement: number)` のようにシグネチャで外から achievement を受け取る。CoreLoop または呼び出し元が SatisficingJudge から計算して渡す。

### 2. `origin` フィールドの許容値

`GoalSchema.origin` は `z.enum(["negotiation", "decomposition", "manual", "curiosity"])` (L127-129)。設計ドキュメントの `"negotiation" | "decomposition" | "manual"` に加えて `"curiosity"` が Stage 11 で追加済み。新しいマイルストーン生成コードではこのいずれかを使う。

### 3. `state-vector.md` §8 の実行経路（未確定）

設計ドキュメントには `on_milestone_target_date()` が「強制観測」を実行するとあるが、それが `ObservationEngine` 直接呼び出しか `TaskLifecycle` 経由かは未確定。Part A の実装では強制観測は省略し、既存の `current_value` を使って pace 計算するのが安全。強制観測は Part A のスコープ外とする。

### 4. `pace_snapshot` フィールドの競合

`GoalSchema.pace_snapshot` は `PaceSnapshotSchema.nullable().default(null)` (L130)。`savePaceSnapshot()` は `loadGoal()` した後に `{ ...goal, pace_snapshot: snapshot }` で `saveGoal()` する — これは既存の atomic write パターンで安全に実装できる。

### 5. `makeGoal` ファクトリの更新

テストで使用している `makeGoal()` ファクトリ（L14-59）はすでに `target_date, origin, pace_snapshot` を `null` で含んでいるため、milestone テスト用のファクトリは `makeGoal({ node_type: "milestone", target_date: "...", origin: "manual" })` のように override するだけで OK。

---

## 8. 実装順序

1. `src/types/state.ts` — `RescheduleOptionsSchema` 追加（型定義、依存なし）
2. `src/state-manager.ts` — `getMilestones()`, `getOverdueMilestones()`, `evaluatePace()`, `savePaceSnapshot()`, `generateRescheduleOptions()` 追加
3. `src/core-loop.ts` — `runOneIteration()` Step 5 直後にマイルストーン期限チェック挿入、`LoopIterationResult` に `milestoneAlerts` 追加
4. `tests/state-manager.test.ts` — pace 評価ユニットテスト追加

---

## 9. ギャップ（未解決）

- **強制観測の実行経路** — Part A では既存 `current_value` を使って回避するが、将来 Part A と ObservationEngine の統合が必要になる場合あり (**Uncertain**)
- **`evaluatePace()` の `currentAchievement` 計算者** — CoreLoop が SatisficingJudge から計算して渡すか、StateManager に SatisficingJudge の参照を DI するかは実装時に決定必要 (**Uncertain**)
