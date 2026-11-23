# Converge API

リアルタイム共同編集 API と Web アプリ。要件は `docs/requirements-v1.0.md`、レビューは `docs/requirements-review.md`、設計判断は `docs/adr/`。

現在: **Phase 0（開発基盤）完了**。

## 前提
- Node.js 24 / pnpm 12（`corepack enable pnpm`）
- MySQL 8.0（ローカル）。専用ユーザーと DB は ADR-0002 を参照

## セットアップ
```sh
pnpm install
cp apps/server/.env.example apps/server/.env   # パスワードを設定
pnpm --filter @converge/server db:generate     # Prisma Client を生成
```

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

## エンドポイント（Phase 0）
| メソッド | パス | 内容 |
|---|---|---|
| GET | /api/v1/health | プロセスの死活監視（DB には触れない） |
| GET | /api/v1/health/db | DB 疎通。異常時は 503 `{"error":{"code":"DB_UNAVAILABLE",...}}`。最大 3 秒で応答する |
