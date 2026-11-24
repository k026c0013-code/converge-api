# 負荷試験（CT-09, ADR-0013）

前提: MySQL、`docker compose up -d redis`、API を 2 つ起動しておく（apps/server で実行）。
```sh
PORT=3001 REDIS_URL=redis://127.0.0.1:6379 RATE_LIMIT_GLOBAL=100000 RATE_LIMIT_AUTH=100000 RATE_LIMIT_MEMBER_ADD=100000 node --env-file=.env --import tsx src/server.ts
PORT=3002 …（同じ）
docker compose --profile lb up -d      # nginx :8080 → :3001 / :3002
node loadtest/gen-payloads.mjs 200     # k6 用の Yjs 更新を生成（payloads.json）
```

- Node クライアント（サーバーの性能を見るのはこちら）:
  `node loadtest/node-load.mjs http://127.0.0.1:3001,http://127.0.0.1:3002 100 5 30`
- k6（REST の P95 とエラー 0 の確認）:
  `docker run --rm --add-host host.docker.internal:host-gateway -v "$PWD/loadtest:/scripts" -w /scripts grafana/k6:1.4.2 run collab.k6.js`

`COLLAB_TIMING=1` を付けて API を起動すると、サーバー内の処理段階ごとの p50/p95 がログに出る。
結果と、計測値の読み方の注意は ADR-0013 §5 にある。
