# ADR-0001: Monorepo 構成とツールのバージョン

- 状態: 採用（2026-11-23）
- 関連: 要件定義書 §2, §5, §14 Phase 0

## 決定
pnpm workspaces による Monorepo。Turborepo などのビルドオーケストレーターは使わない（パッケージ数が少ないうちは不要。必要になった時点で ADR を起こす）。

```
converge-api/
├─ apps/
│  ├─ server/   Fastify。REST API と Collaboration Server を同一プロセスで動かすが、src/modules/* で分離（§2）
│  └─ web/      React + Vite。API のクライアントとしてのみ振る舞う（§10）
├─ packages/    必要になった時点で追加（予定: shared=API/プロトコル型, crdt=CRDTEngine, client=Yjs プロバイダー/将来の SDK）
└─ docs/        要件定義書・レビュー・ADR
```

`packages/*` は Phase 0 では作らない（使う側がないため。§19-2「要件にない機能を勝手に追加しない」）。

## バージョン（2026-11-23 時点、exact pin）
| 用途 | パッケージ | 版 | 備考 |
|---|---|---|---|
| ランタイム | Node.js | 24.x | `.node-version` |
| パッケージ管理 | pnpm | 12.21.0 | corepack。`allowBuilds` で install script を許可制 |
| 言語 | TypeScript | 7.0.2 | ネイティブ版 tsc |
| API | fastify | 5.12.8 | |
| ORM | prisma / @prisma/client / @prisma/adapter-mariadb | 7.10.1 | npm の `latest` タグは 8.0 RC を指しているため安定版 7.10.1 に固定 |
| Web | react 19.3.1 / vite 8.3.8 / @vitejs/plugin-react 6.3.0 | | |
| テスト | vitest | 5.1.1 | web は jsdom + @testing-library/react |
| 実行 | tsx | 4.23.15 | server の dev 実行 |

## 理由
- pnpm: ワークスペースが標準機能で厳密な依存解決（幽霊依存を防ぐ）。install script を許可制にできるのはサプライチェーン対策になる。
- Fastify と ws: `@fastify/websocket` が内部で ws を使うため、要件 §5.1 の両方を満たせる（Phase 2 で導入）。
