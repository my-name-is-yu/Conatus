# Doc Update Research — After Stage 11 (A+B+C)

Researched: 2026-03-14

## Scope Note

The user asked about Stage 11C (CuriosityEngine). However, git status shows that
Stage 11A and 11B files are ALSO present as untracked/modified but not reflected in
docs yet. The docs currently describe Stage 1-10 only. All three sub-stages need to
be documented.

**What is actually implemented (from git status + file system):**

- Stage 11A (Ethics Gate Layer 1): `src/ethics-gate.ts` (modified), `src/types/ethics.ts` (modified), `src/goal-negotiator.ts` (modified)
- Stage 11B (Character + Satisficing Phase 2): `src/character-config.ts` (new), `src/types/character.ts` (new), `src/satisficing-judge.ts` (modified), `src/stall-detector.ts` (modified), `tests/character-config.test.ts` (new), `tests/character-separation.test.ts` (new)
- Stage 11C (Curiosity MVP): `src/curiosity-engine.ts` (new, implied), `src/types/curiosity.ts` (new), `src/types/goal.ts` (modified), `src/core-loop.ts` (modified), `src/index.ts` (modified), `tests/curiosity-engine.test.ts` (new)

**Test file count**: 32 files (was 30 after Stage 10; +curiosity-engine.test.ts, +character-config.test.ts, +character-separation.test.ts)
**Type schema file count**: 23 files (was 20 after Stage 10; +character.ts, +ethics.ts already existed but were modified, +curiosity.ts = net +3 new type files; index.ts and report.ts were already counted in the 20, so actual new type files are character.ts and curiosity.ts = +2 net new schemas)

Note on type file count: `src/types/ethics.ts` was already present before Stage 11 (it appears in git modified, not untracked). So new type files are: `character.ts` and `curiosity.ts` = total 22 schema files (was 20, +2).

**Test count**: The user states 103 tests for curiosity-engine.test.ts alone. Stage 11 plan estimated ~80+~100+~120 = ~300 new tests. Actual total unknown without running vitest; use ">1542" as minimum (1439 + 103 curiosity). Document as "1542+ tests, 32 test files" pending vitest run confirmation.

---

## 1. docs/status.md

**Current state**: Ends at Stage 10, line 55. Last line: "1439 tests passing across 30 test files."

**What needs adding**: A new Stage 11 section after line 55.

```
## Stage 11 (complete)
- 11A Ethics Gate Layer 1: `src/ethics-gate.ts` — category-based blocklist (intent-level classification, LLM-free fast filter, jailbreak resistance), `checkMeans()` integration in TaskLifecycle, `src/types/ethics.ts` (updated)
- 11B Character Customization: `src/character-config.ts` — 4-axis parameter management (caution_level, stall_flexibility, communication_directness, proactivity_level), structural-constraint isolation tests, `src/types/character.ts` (new); SatisficingJudge and StallDetector extended for character parameter integration
- 11C Curiosity Engine MVP: `src/curiosity-engine.ts` — 5 trigger conditions (empty task queue, unexpected observation, repeated failure, undefined problem, periodic exploration), LLM-based curiosity goal proposal, approval flow, learning feedback (high-impact domain priority, failure pattern reconstruction, blind spot detection), cross-goal transfer (dimension_name exact match), resource budget (max 20%, user goals always priority), auto-expiry (12h), concurrent proposal cap (3); `src/types/curiosity.ts` (new), `src/types/goal.ts` updated (origin: "user" | "curiosity"), CoreLoop updated (optional curiosityEngine in deps, curiosity evaluation after loop completion)
- `src/types/character.ts`, `src/types/curiosity.ts` — 2 new Zod schema files (total: 22)
- 1542+ tests passing across 32 test files
```

**Lines**: Insert after line 55 (end of file).

---

## 2. docs/roadmap.md

**Current state**: Stage 11 section (lines 125-170) describes 11.1–11.4 as future work. The "前提" line at line 3 says "Stage 1-9 完了（1266テスト、24テストファイル）" — itself outdated (Stage 10 is complete).

**What needs changing**:

### Line 3 (preamble):
- Current: `前提: Stage 1-9 完了（1266テスト、24テストファイル）。実装済みの詳細は docs/status.md 参照。`
- Change to: `前提: Stage 1-11 完了（1542+テスト、32テストファイル）。実装済みの詳細は docs/status.md 参照。`

### Lines 5-15 (Stage 1-9 list):
- Add after line 15: `- Stage 10: DaemonRunner、PIDManager、Logger、EventServer、NotificationDispatcher、MemoryLifecycleManager、CIワークフロー`
- Add: `- Stage 11: EthicsGate Layer 1（カテゴリブロックリスト）、CharacterConfig（4軸パラメータ）、CuriosityEngine MVP（5発動条件、学習フィードバック、リソース予算）`

### Lines 43-48 (全体サマリー table):
- Stage 11 row: add "(完了)" marker to the テーマ column, e.g. `| **11** | 好奇心・倫理・キャラクター **(完了)** | 4. 正直な交渉, 5. 自律的知識獲得(MVP) | 9（10と並行可能） |`

### Lines 125-170 (Stage 11 section body):
- Mark all subsections as implemented. Add a "(実装済み)" note at the top of the Stage 11 section.
- Current opening: `Stage 10と並行して着手可能。「指示されたことを実行する」から...`
- Prepend: `**[実装済み — Stage 11A/11B/11C 完了]**`

### ASCII diagram (lines 52-58):
- Current shows "Stage 9 (完了)" and lists Stage 10 etc. without 11 completion marker.
- Add "(完了)" to Stage 11 in the diagram:
  ```
  └── Stage 11 (好奇心・倫理) ────┘ (完了)
  ```

---

## 3. docs/architecture-map.md

**Current state**:
- Line 289 (section 5 implementation status note): `実装状況（2026-03-14時点）: Stage 1-9完了 — 1266テスト通過、24テストファイル。`
- Line 290: Lists implemented modules ending with `PortfolioManager（Stage 9）。TUI層（Stage 7-8, 11ファイル in src/tui/）。`
- Line 291: `Zodスキーマ: 17ファイル（knowledge.ts, capability.ts, portfolio.ts を追加）`
- Line 292: `次ステップ: Stage 10+（memory-lifecycle, 高度な好奇心, マルチエージェント協調等）。詳細は docs/roadmap.md。`

**What needs changing**:

### Line 289 status note — full replacement:
- Current: `実装状況（2026-03-14時点）: Stage 1-9完了 — 1266テスト通過、24テストファイル。`
- New: `実装状況（2026-03-14時点）: Stage 1-11完了 — 1542+テスト通過、32テストファイル。`

### Line 290 module list — append:
- After `PortfolioManager（Stage 9）。TUI層（Stage 7-8, 11ファイル in src/tui/）。`
- Add: `DaemonRunner、PIDManager、Logger、EventServer、NotificationDispatcher、MemoryLifecycleManager（Stage 10）。EthicsGate Layer 1、CharacterConfig（Stage 11A/11B）。CuriosityEngine（Stage 11C）。`

### Line 291 Zod schema count:
- Current: `Zodスキーマ: 17ファイル（knowledge.ts, capability.ts, portfolio.ts を追加）`
- New: `Zodスキーマ: 22ファイル（daemon.ts, notification.ts, memory-lifecycle.ts, character.ts, curiosity.ts を追加）`

### Line 292 next steps:
- Current: `次ステップ: Stage 10+（memory-lifecycle, 高度な好奇心, マルチエージェント協調等）。詳細は docs/roadmap.md。`
- New: `次ステップ: Stage 12+（意味的埋め込み、知識進化）。詳細は docs/roadmap.md。`

### Section 2 (Architecture diagram) — "横断的な仕組み" box (line 64-66):
- Current: `信頼と安全 │ 満足化 │ 停滞検知 │ 好奇心 │ 実行境界`
- CuriosityEngine is now implemented — no change needed (curiosity was already listed here conceptually). But could add "キャラクター" to the list.
- Suggested: `信頼と安全 │ 満足化 │ 停滞検知 │ 好奇心 │ 実行境界 │ キャラクター`

### Section 6 (横断的な仕組み) — add CuriosityEngine description:
- Line 401-402: `好奇心（curiosity）` paragraph describes the concept. Add implementation note.
- Current text ends at: `未承認は12時間で自動失効。`
- Append: `Stage 11C で CuriosityEngine として実装済み。5発動条件、LLMによるゴール提案、承認フロー、学習フィードバック（高インパクトドメイン優先・失敗パターン再構成・盲点検出）、クロスゴール転移（dimension_name完全一致）、リソース予算（最大20%）を備える。`

- Similarly, after the `ゴール交渉（goal-negotiation）` paragraph and `実行境界（execution-boundary）` paragraph, add a new `キャラクター（character）` paragraph:
  - Position: after line 408 (execution-boundary paragraph)
  - New paragraph:
    ```
    **キャラクター（character）**
    4軸パラメータ（caution_level / stall_flexibility / communication_directness / proactivity_level）でMotivaの行動特性を調整可能にする。CharacterConfigとして実装済み（Stage 11B）。構造的制約（倫理ゲート・不可逆ルール）への波及を防ぐ分離テストを含む。
    ```

---

## 4. docs/mechanism.md

**Current state**: Section 4 (学習, lines 270-355) has a subsection "メタ動機（好奇心）" (lines 289-293) that describes curiosity conceptually but has no implementation note. The Stage 8 implementation table at line 346-353 covers only Stage 8.

**What needs changing**:

### Lines 289-293 (メタ動機（好奇心）subsection):
- Current ends with: `好奇心はあくまで提案だ。ユーザーが受け入れなければ追求しない。`
- Append implementation note: `Stage 11C で CuriosityEngine として実装済み。詳細は \`design/curiosity.md\` を参照。`

### Lines 346-353 (Stage 8以降の実装状況 table):
- Table header says "Stage 8以降" — should be updated to "Stage 8-11以降" or a new row added.
- Add a note or new rows covering Stage 11 additions:
  ```
  | 分析トリガー | Stage 11C で **好奇心評価** がコアループ完了後に追加された。全ゴール完了時・タスクキュー空時・繰り返し失敗時・定期探索タイミングで CuriosityEngine が発動する |
  | フィードバック先 | CuriosityEngine の学習フィードバックが高インパクトドメインの優先度を動的調整する |
  ```

Note: mechanism.md's curiosity section (§4 メタ動機) is conceptual and not heavily code-tied. The change is minimal — just confirming implementation status.

---

## 5. CLAUDE.md

**Current state**:
- Line 11: `Implementation Phase — Stage 1-10 complete (1439 tests, 30 test files).`
- Lines 52-54 (Layer 8 and beyond):
  ```
  - Layer 8: KnowledgeManager, CapabilityDetector (cross-cutting, injected into Layer 3-4)
  - Layer 9: PortfolioManager (orchestrates parallel strategies between DriveScorer and TaskLifecycle)
  - Layer 10: DaemonRunner, PIDManager, Logger, EventServer, NotificationDispatcher, MemoryLifecycleManager
  ```

**What needs changing**:

### Line 11 (Status):
- Current: `Implementation Phase — Stage 1-10 complete (1439 tests, 30 test files).`
- New: `Implementation Phase — Stage 1-11 complete (1542+ tests, 32 test files).`

### After line 54 (Layer 10), add Layer 11:
- New line: `- Layer 11: EthicsGate (Layer 1 blocklist), CharacterConfig, CuriosityEngine`

### Line 61 (Design Documents count):
- Current: `- docs/design/ — detailed design for each subsystem (19 files)`
- The number of design files is unchanged by Stage 11 (curiosity.md, character.md, goal-ethics.md were already in docs/design/). No change needed here.

---

## 6. memory/MEMORY.md (user memory at ~/.claude/agent-memory)

Note: The MEMORY.md for this project is at the auto-memory path, NOT at
`/Users/yuyoshimuta/Documents/dev/Motiva/memory/MEMORY.md` (that file does not exist).
The project-level memory is at:
`/Users/yuyoshimuta/.claude/projects/-Users-yuyoshimuta-Documents-dev-Motiva/memory/MEMORY.md`

**Current state** (relevant sections):
- Line 1: `# Motiva — Project Memory`
- "プロジェクト状態" section: `Stage 1-10: 完了、1439テスト、30テストファイル`
- "TUI Phase 1-2: 実装済み（10ファイル in src/tui/）"
- "次のステップ" section references Stage 11 plan (stage11-plan.md)

**What needs changing**:

### プロジェクト状態 section:
- Current: `Stage 1-10: 完了、1439テスト、30テストファイル`
- New: `Stage 1-11: 完了、1542+テスト、32テストファイル`
- Current: `Post-MVPロードマップ: docs/roadmap.md (Stage 11-14)`
- New: `Post-MVPロードマップ: docs/roadmap.md (Stage 12-14)`

### 実装済みモジュール section — add Stage 11 entry:
After the Stage 10 entry, add:
```
### Stage 11 (Layer 11)
- `src/ethics-gate.ts` — Layer 1 category blocklist (intent classification, LLM-free fast filter, jailbreak resistance), `checkMeans()` integration
- `src/types/ethics.ts` — updated ethics types
- `src/character-config.ts` — 4-axis character parameter management (caution_level, stall_flexibility, communication_directness, proactivity_level), structural constraint isolation
- `src/types/character.ts` — CharacterConfig Zod schema
- `src/curiosity-engine.ts` — 5 trigger conditions, LLM proposal generation, approval flow, learning feedback, cross-goal transfer (dimension_name match), resource budget (max 20%), auto-expiry (12h), concurrent proposal cap (3)
- `src/types/curiosity.ts` — CuriosityGoal, CuriosityConfig Zod schemas
- `src/types/goal.ts` — added origin: "user" | "curiosity" to Goal schema
- `src/core-loop.ts` — optional curiosityEngine in CoreLoopDeps, curiosity evaluation post-loop
- テスト: character-config.test.ts, character-separation.test.ts, curiosity-engine.test.ts (103 tests)
```

### 次のステップ section:
- Current: references Stage 11 plan (Phase 11A → 11B → 11C)
- New: Update to reference Stage 12 as next step
- Replace with: `**Stage 12（意味的埋め込みと知識進化）** — 埋め込み基盤、知識獲得Phase 2、好奇心Phase 2（ファジー類似度）`

---

## Summary Table

| File | Lines affected | Change type |
|------|---------------|-------------|
| `docs/status.md` | After line 55 (EOF) | Add Stage 11 section (~12 lines) |
| `docs/roadmap.md` | Lines 3, 5-15, 43-48, 52-58, 125 | Update counts + mark Stage 11 complete |
| `docs/architecture-map.md` | Lines 64-66, 289-292, 401-408 | Update counts, add CuriosityEngine/CharacterConfig descriptions |
| `docs/mechanism.md` | Lines 291-293, 346-353 | Add impl note to curiosity section, extend Stage 8 table |
| `CLAUDE.md` | Lines 11, 54 | Update status count, add Layer 11 |
| `memory/MEMORY.md` (auto-memory) | プロジェクト状態, 実装済みモジュール, 次のステップ | Update stage count, add Stage 11 module list |

## Gaps / Uncertainties

- **Exact test count**: Cannot confirm total test count without running `npx vitest run`. Used 1542+ (1439 + 103 curiosity tests minimum; character tests add more). **Uncertain** — recommend running vitest to get exact count before updating docs.
- **Stage 11A/11B modifications**: The exact scope of ethics-gate.ts and satisficing-judge.ts changes is not read (Boss rule). Described based on stage11-plan.md design intent. **Likely** accurate.
- **Layer numbering for Stage 11**: stage11-plan.md and CLAUDE.md Layer 10 ends at DaemonRunner etc. Stage 11 modules (EthicsGate L1, CharacterConfig, CuriosityEngine) fit as "Layer 11" or could be considered extensions of Layer 3 (EthicsGate) and cross-cutting (Curiosity). **Uncertain** — treat as new Layer 11 for doc consistency, but this should be confirmed with the user.
- **`docs/design/` file count**: Currently listed as 19 files in CLAUDE.md. character.md, curiosity.md, goal-ethics.md were pre-existing. Count should still be 19 unless new design files were added. **Confirmed** no new design files from git status.
