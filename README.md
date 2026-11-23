# Converge API

リアルタイム共同編集 API と Web アプリ。要件は `docs/requirements-v1.0.md`、レビューは `docs/requirements-review.md`、設計判断は `docs/adr/`。

現在: **Phase 3（Yjs による共同編集）完了**。設計は ADR-0008（Phase 1）、ADR-0009（Phase 2）、ADR-0010（Phase 3）。

## 前提
- Node.js 24 / pnpm 12（`corepack enable pnpm`）
- MySQL 8.0（ローカル）。専用ユーザーと DB は ADR-0002 を参照

## セットアップ
```sh
pnpm install
cp apps/server/.env.example apps/server/.env   # パスワードを設定
pnpm --filter @converge/server db:generate     # Prisma Client を生成
pnpm --filter @converge/server db:migrate      # dev DB にマイグレーションを適用
# テスト DB にも適用（TEST_DATABASE_URL を DATABASE_URL として渡す）
#   cd apps/server && DATABASE_URL=<TEST_DATABASE_URL の値> npx prisma migrate deploy
```
`.env` の `JWT_SECRET` は 32 文字以上の乱数にする（未設定・短い・`CHANGE_ME` のままだと起動しない）。

## 起動
```sh
pnpm dev        # API http://127.0.0.1:3000 と Web http://127.0.0.1:5173 を同時起動
```
Web の `/api/*` は Vite のプロキシで API に転送される。

## テスト
```sh
pnpm test       # server: 単体テスト + MySQL 結合テスト（TEST_DATABASE_URL があれば実行）, web: コンポーネントテスト
pnpm typecheck
```

## エンドポイント
仕様は OpenAPI 3.1（`docs/openapi.json`、実行中は `GET /api/v1/openapi.json`）。再生成: `pnpm --filter @converge/server openapi:export`

| メソッド | パス | 内容 | 権限 |
|---|---|---|---|
| GET | /api/v1/health | プロセスの死活監視（DB には触れない） | なし |
| GET | /api/v1/health/db | DB 疎通。異常時は 503 `DB_UNAVAILABLE`（最大 3 秒） | なし |
| POST | /api/v1/auth/register | 登録（トークンも返す） | なし |
| POST | /api/v1/auth/login | ログイン | なし |
| POST | /api/v1/auth/refresh | リフレッシュトークンのローテーション（再利用を検知したら系列ごと失効） | なし |
| POST | /api/v1/auth/logout | リフレッシュトークンの系列を失効 | なし |
| GET | /api/v1/users/me | 自分の情報 | ログイン |
| POST / GET | /api/v1/documents | 作成 / 一覧（カーソルページング） | ログイン |
| GET / PATCH / DELETE | /api/v1/documents/{id} | 取得 / タイトル変更（Owner・Editor）/ 論理削除（Owner） | メンバー |
| GET / POST | /api/v1/documents/{id}/members | 一覧 / 追加（Owner、メールで指定） | メンバー |
| PATCH / DELETE | /api/v1/documents/{id}/members/{userId} | 権限変更 / 削除（Owner） | Owner |

エラーは常に `{"error":{"code","message","details"?}}`。メンバーでない文書には 404 を返す（存在を隠す）。

## リアルタイム（ADR-0009, ADR-0010）
1. `POST /api/v1/documents/{id}/ws-ticket`（JWT 付き）で 30 秒・1 回限りのチケットを取る
2. `ws://…/ws/documents/{id}?ticket=…` へ接続 → `session:ready`（参加者一覧）
3. `sync:request {stateVector}` → `sync:response {update, stateVector}` → `sync:complete`
4. `update:submit`（Yjs 更新, base64）→ 検証（`content` ルートのみ）→ `document_updates` に保存 → `update:ack` → 他の接続へ `update:broadcast`
5. `awareness:update` は名前・色をサーバーが上書きして配信（保存しない）

権限変更は接続中にも反映される（降格 → `session:role_changed`、除外 4003、文書削除 4004、ログアウト 4001）。
クライアントライブラリは `packages/client`（`@converge/client`: `ConvergeConnection` = チケット・在席・自動再接続、`YjsSync` = Y.Doc/Awareness の同期と再接続時の差分回復）。
Web アプリ（`pnpm dev` → http://127.0.0.1:5173）でログイン → 文書を開くと Tiptap エディタで共同編集できる（見出し・太字・斜体・箇条書き・番号付き・他人のカーソル）。
ブラウザの Origin 許可リストは `WS_ALLOWED_ORIGINS`（既定は Vite の開発サーバー）。
