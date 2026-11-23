# ADR-0012: Phase 5 の履歴・スナップショット・バージョン・復元

- 状態: 採用（2026-11-23、ユーザーが判断を委任「承認なしに進め続けていい」）
- 関連: レビュー R-07, R-08, R-09, R-15 / 要件定義書 §3, §4.6, §8.5, §8.6, §9, 未決定事項5・6 / Phase 5

## 1. スナップショット（§8.5、未決定事項6 の推奨案）
- `document_snapshots`: `id`, `document_id`, `state_data LONGBLOB`, `last_update_id BIGINT`（この id までの更新を含む。R-09）, `created_at`
- **作るタイミング**: (a) 前のスナップショットから 500 件の更新が積み上がったとき、(b) バージョンを作るとき
- **読み込み**: 最新のスナップショットを適用し、`id > last_update_id` の更新だけを順に適用する（R-15）。
- スナップショットは文書ごとの直列キューの中で、ライブ文書から作る。ライブ文書の状態と `last_update_id` は常に一致する。
- **更新ログは削除しない**。保持期間（未決定事項5）が決まるまで、圧縮後の古い更新も残す。

## 2. バージョン（§8.6、R-09）
- `document_versions`: `id`, `document_id`, `snapshot_id`, `created_by`, `name VARCHAR(100)`, `note VARCHAR(500) NULL`, `kind`（`manual` / `pre_restore`）, `created_at`
- バージョンを作れるのは **Owner と Editor**（本文を編集できる人が「ここで保存」できるのは自然なため）。閲覧は全メンバー（§3「編集履歴の閲覧」）。

## 3. 復元（§4.6, R-07）
- **Owner のみ**（§3）。
- 復元は過去の状態で上書きするのではなく、**新しい編集として反映する**（§4.6）。サーバーは直列キューの中で次の手順を行う。
  1. **自動で「復元前」バージョンを作る**（`kind = pre_restore`）。復元を取り消したいときにいつでも戻れるので、データを失わない。
  2. ライブ文書の写しの上で、`content` の子要素をすべて削除し、復元対象バージョンの子要素の複製を挿入する。これで 1 つの Yjs 更新を作る。
  3. この更新を通常の更新と同じ順序で処理する: 保存（`client_id = "server:restore"`, `user_id` = 復元した人）→ ライブ文書へ適用 → 接続中の全員へ `update:broadcast`。
- **並行編集の扱い（CT-10 の期待値の定義）**: 復元と同時に他の人が編集していると、その編集は復元後の内容に**混ざりうる**（CRDT の性質。文書のロックはしない）。CT-10 は「復元の直後、並行編集がなければ、文書の内容が指定バージョンと一致する」ことを確認する。
- 復元は監査ログに `document.restore`（`metadata.versionId`）として残す。バージョンの作成は `version.create` として残す。

## 4. API（§9, R-08）
| メソッド | パス | 内容 | 権限 |
|---|---|---|---|
| GET | `/documents/{id}/history` | 更新ログ（id, updateId, userId, displayName, size, createdAt）。カーソルページング、新しい順。payload は返さない | メンバー |
| GET | `/documents/{id}/versions` | バージョン一覧（新しい順） | メンバー |
| POST | `/documents/{id}/versions` | `{ name, note? }` で、いまの状態をバージョンとして保存 | Owner / Editor |
| GET | `/documents/{id}/versions/{versionId}` | 過去状態の参照。メタデータ、`state`（Yjs 更新, base64）、`content`（XML の文字列） | メンバー |
| POST | `/documents/{id}/restore` | `{ versionId }` → `{ restoredVersionId, preRestoreVersionId }` | Owner |
