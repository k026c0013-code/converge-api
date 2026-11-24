# Converge API

リアルタイム共同編集 API と Web アプリ。要件は `docs/requirements-v1.0.md`、レビューは `docs/requirements-review.md`、設計判断は `docs/adr/`。

現在: **Phase 6 まで完了し、Phase 7 はコンテナ化と CI まで**（公開サーバーは置かない、ADR-0014）。

## このプロジェクトで示せること
| 観点 | 内容 | 根拠 |
|---|---|---|
| CRDT による共同編集 | Yjs ＋ Tiptap。同時編集・順序の入れ替わり・重複配送があっても全員が同じ状態に収束する | CT-01〜05 のテスト、fast-check による性質ベーステスト（`packages/client/test`, `apps/server/test/crdt.integration.test.ts`） |
| 永続化の正しさ | 保存してから反映・ACK・配信の順を守る。再起動後も DB から復元できる | ADR-0003, ADR-0010, CT-07 |
| セキュリティ | argon2id、ローテーションするリフレッシュトークンと再利用検知、1 回限りの WS チケット、Origin 検査、更新内容の検証、Awareness のなりすまし防止、監査ログ | ADR-0005, 0008, 0010、`auth.integration` / `collab.integration` のテスト |
| オフライン編集 | IndexedDB に保存し、再接続時に state vector で差分を統合する | ADR-0011, CT-06 |
| 履歴・復元 | スナップショット、名前付きバージョン、新しい編集としての復元（復元前の状態は自動で保存） | ADR-0012, CT-10 |
| 分散化 | Redis で複数サーバーをつなぐ。取りこぼしは DB から回復し、ノードが落ちても別のノードへ切り替わる | ADR-0013、`cluster.integration` のテスト |
| 性能 | 2 ノード・100 接続で、反映 P95 87 ms（目標 200 ms）、エラー 0 件 | ADR-0013 §5 |
| 進め方 | 要件をレビューして、判断を ADR 14 本に残し、テストは 159 件 | `docs/requirements-review.md`, `docs/adr/` |

## すぐに試す（Docker だけで動く）
```sh
cp .env.example .env            # 値を乱数に置き換える
docker compose --profile full up -d --build
# → http://localhost:8080 を 2 つのブラウザで開き、別々のアカウントで同じ文書を編集する
```

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

## オフライン編集（Phase 4, ADR-0011）
- 文書は IndexedDB（`converge:{userId}:{documentId}`）にも保存され、接続が切れても編集を続けられる。
- 再接続すると state vector を交換して、足りない差分の取得と未送信分の送信を行い、ACK がそろうと「同期済み」になる。
- ログアウト時は保存済みの文書だけローカルから消える。未送信の変更がある文書は次回のログインまで残る。
- アクセストークンはメモリだけに持つので、ページの再読み込みにはオンラインでのログインが必要。

## 履歴・バージョン・復元（Phase 5, ADR-0012）
| メソッド | パス | 内容 | 権限 |
|---|---|---|---|
| GET | /api/v1/documents/{id}/history | 更新ログ（新しい順、`before` でページング） | メンバー |
| GET / POST | /api/v1/documents/{id}/versions | 一覧 / いまの状態を名前付きで保存 | メンバー / Owner・Editor |
| GET | /api/v1/documents/{id}/versions/{versionId} | 過去状態の参照（Yjs 状態と XML） | メンバー |
| POST | /api/v1/documents/{id}/restore | 新しい編集として復元。直前の状態は「復元前」バージョンとして自動保存 | Owner |

スナップショットは 500 更新ごととバージョン作成時に作られ、読み込みは「最新スナップショット＋それ以降の更新」で行う。更新ログは削除しない（保持期間は未決定）。

## 複数サーバー（Phase 6, ADR-0013）
- `docker compose up -d redis` を実行し、`.env` に `REDIS_URL=redis://127.0.0.1:6379` を設定すると、複数の API サーバーで同じ文書を共同編集できる（チケット・在席・更新・権限変更を Redis で共有）。
- `docker compose --profile lb up -d` で、nginx（:8080）が :3001 と :3002 に振り分ける。
- 負荷試験は `loadtest/README.md` を参照。結果（2 ノードで反映 P95 87 ms）は ADR-0013 §5 にある。

