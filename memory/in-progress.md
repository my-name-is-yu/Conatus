# In-Progress

## 次の作業: 柱1 ファイル分割

計画: `docs/design/phase3-plan.md` の柱1セクション参照

### コンテキスト
- Phase 1-2: src/リストラクチャリング完了（45ファイル移動 + 4大ファイル分割）— コミット済み
- Phase 3計画: `docs/design/phase3-plan.md` に記録済み
- モジュール境界マップ: `docs/module-map.md` に記録済み
- 柱3（テスト効率化）: 完了 — コミット待ち
  - `test:fast` (8秒、遅いshellテスト除外)
  - `test:e2e` (4秒、E2Eのみ)
  - `test:unit` (E2E除外)
  - `test:changed` (変更ファイル関連のみ)
