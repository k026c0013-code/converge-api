# ADR-0008: Phase 1 の認証・ドキュメント・権限の設計

- 状態: 採用（2026-11-23、ユーザーが判断を委任「承認なしに進め続けていい」）
- 関連: レビュー R-08, R-09 / 要件定義書 §3, §4.1, §4.2, §8, §9, §13, 未決定事項3 / Phase 1

## 1. 認証（未決定事項3「認証方式の詳細」の Phase 1 部分）
| 項目 | 決定 | 理由 |
|---|---|---|
| パスワードハッシュ | argon2id（`@node-rs/argon2`、m=19456 KiB, t=2, p=1 = OWASP 推奨の最小値） | OWASP の第一推奨。ビルド済みバイナリで、pnpm のインストールスクリプト制限に掛からない |
| パスワード規則 | 8〜128 文字。文字種の強制はしない | NIST SP 800-63B に従う。上限は DoS 対策 |
| アクセストークン | JWT（HS256, `jose`）、有効期限 15 分。`sub`=userId, `iss`/`aud` を検証 | 短命にして失効管理を不要にする |
| 署名鍵 | 環境変数 `JWT_SECRET`（32 文字以上、未設定・短すぎなら起動しない） | |
| リフレッシュトークン | 不透明な乱数 32 バイト（base64url）、有効期限 30 日。DB には SHA-256 だけを保存 | DB が漏れてもトークンとして使えない |
| ローテーション | `/auth/refresh` のたびに新しいトークンを発行し、古いものは失効させる | |
| 再利用検知 | 失効済みトークンが使われたら、同じ系列（`family_id`）を全部失効させ、監査ログに残す | トークンの盗用を検知して被害を止める |
| 受け渡し | JSON の本文で返す（Cookie は使わない） | 外部の開発者向け API が主目的（§1）。Web アプリでの保管方法は Phase 3 のフロントエンドで決める |
| ログアウト | 渡されたリフレッシュトークンの系列を失効させる。冪等で常に 204 | |
| ログイン失敗 | 存在しないメールでもダミーハッシュを検証して時間をそろえる。エラー文言も同じ（`INVALID_CREDENTIALS`） | ユーザーの存在確認に使わせない |
| メールアドレス | 前後の空白を除き、小文字にして保存・照合する | |

## 2. ドキュメントと権限（R-09）
- **Owner は文書ごとに 1 人**で、`documents.owner_id` が正。`document_members` は Editor / Viewer だけを持つ（`role` は `editor` / `viewer`）。二重管理をなくすため。
  - Owner の譲渡は要件にないので作らない。Owner は削除・降格できない。
  - メンバー一覧の API は、Owner を `role: "owner"` として先頭に含めて返す。
- **削除は論理削除**（`documents.deleted_at`）。削除済みの文書は全 API で 404 にする。物理削除（完全消去）は、保持期間（未決定事項5）が決まってから作る。
- `engine` / `format_version` は ADR-0006 のとおり。
- 権限表（§3）。メンバーでない人には、文書の存在を隠すため **404** を返す。メンバーだが権限が足りない場合は **403** を返す。

| 操作 | Owner | Editor | Viewer |
|---|---|---|---|
| 取得・メンバー一覧 | ○ | ○ | ○ |
| タイトル変更（PATCH） | ○ | ○ | × |
| 削除 | ○ | × | × |
| メンバー追加・削除・権限変更 | ○ | × | × |

- タイトル変更を Editor にも許すのは、本文の編集権限があれば題名も直せるのが自然なため（ADR-0004 で、タイトルの正は DB）。

## 3. API の追加（R-08）
要件 §4 にあり、§9 の一覧から漏れていたものを追加する。
- `GET /api/v1/users/me` — §4.1「ユーザー情報の取得」
- `PATCH /api/v1/documents/{id}/members/{userId}` — §4.2「メンバー権限変更」
- メンバーの追加は `{ "email", "role" }` で指定する。ユーザーがいなければ 404 `USER_NOT_FOUND` を返す。
  - これで「そのメールのユーザーがいるか」が分かってしまうが、ログイン済みで、かつ Owner であることが条件になる。さらにレート制限（1 分 20 回/ユーザー）を掛けて抑える。userId 指定だと、相手の ID を知る手段がない。
- 履歴・バージョン・復元（`/history`, `/versions`, `/restore`）と `ws-ticket`（ADR-0005）は Phase 2〜5 で作る。

## 4. 共通仕様（§9）
- 成功: リソースをそのまま JSON で返す。一覧は `{ "items": [...], "nextCursor": string | null }` とし、カーソル方式でページングする（`limit` 既定 20、最大 100）。
- エラー: `{ "error": { "code": "UPPER_SNAKE", "message": "...", "details"?: [...] } }`（Phase 0 の health と同じ形）。500 では内部の詳細を返さない。
- 入力検証: TypeBox のスキーマで本文・パス・クエリを検証する。未知のプロパティは拒否する。
- 認可: `Authorization: Bearer <JWT>`。なければ・不正なら 401 `UNAUTHORIZED`。
- 本文サイズの上限: 64 KiB（§13）。
- レート制限（§13）: 全体 300 回/分/IP。`register`・`login`・`refresh` は 10 回/分/IP。プロセス内のメモリで数え、Phase 6 で Redis に移す。
- OpenAPI（§9）: `@fastify/swagger` でルートのスキーマから生成し、`GET /api/v1/openapi.json` で返す。`docs/openapi.json` にも書き出す。

## 5. 監査ログ（R-09, §4.6, §13）
`audit_logs` を Phase 1 から作る。CRDT の更新ログ（Phase 3）とは別の表にする。
- 記録するもの: 登録、ログイン成功・失敗、ログアウト、リフレッシュトークンの再利用検知、文書の作成・削除・タイトル変更、メンバーの追加・削除・権限変更
- 列: `actor_user_id`（失敗時は NULL）、`action`、`document_id`、`target_user_id`、`ip`、`metadata`（JSON）、`created_at`
- パスワード・トークン・メールアドレスは記録しない。

## 6. スキーマ（MySQL、ADR-0002 の型の読み替えに従う）
- `users`: id, email(UNIQUE), display_name VARCHAR(50), password_hash, created_at, updated_at
- `refresh_tokens`: id, user_id, family_id, token_hash(UNIQUE), expires_at, revoked_at, replaced_by_id, created_at
- `documents`: id, title VARCHAR(200), owner_id, engine, format_version, created_at, updated_at, deleted_at
- `document_members`: (document_id, user_id) PK, role, joined_at
- `audit_logs`: id BIGINT AUTO_INCREMENT, …（上記）
- 外部キー: ユーザーは参照されている間は削除できない（RESTRICT）。文書の物理削除ではメンバーも消す（CASCADE。物理削除は Phase 1 では起きない）。
- `document_updates` / `document_snapshots` / `document_versions` は Phase 3 / 5 で追加する。

## 7. 推奨案のまま（決定ではない）
- ユーザー自身の退会、メールアドレス・パスワードの変更は要件 §4.1 にないので作らない。
