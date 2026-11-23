# ADR-0009: Phase 2 の WebSocket サーバー・プロトコル・権限変更の伝達

- 状態: 採用（2026-11-23、ユーザーが判断を委任「承認なしに進め続けていい」）
- 関連: ADR-0005（接続チケット）, ADR-0007（Phase 2 の範囲）, レビュー R-12, R-13 / 要件定義書 §4.7, §7 / Phase 2

## 1. 接続
- パスは要件 §7.1 に合わせて `/ws/documents/{documentId}?ticket=<チケット>` とする（ADR-0005 の `/collab` は仮の名前だったので、こちらに置き換える）。
- `ws` ライブラリを `noServer` モードで使い、Fastify の HTTP サーバーの `upgrade` イベントで次の順にハンドシェイクを検証する。失敗したら **HTTP ステータスで拒否**し、WebSocket にはしない。
  1. パスと documentId（UUID）の確認 → 404
  2. Origin の確認（許可リスト `WS_ALLOWED_ORIGINS`。Origin ヘッダーがないブラウザ以外のクライアントは、チケットだけで認証する）→ 403
  3. チケットの検証と消費（30 秒・1 回限り・userId と documentId に結び付け）→ 401
  4. 文書が存在して削除されておらず、ユーザーがまだメンバーであることを確認（チケット発行後の変更に備える）→ 404
- チケットの発行: `POST /api/v1/documents/{id}/ws-ticket`（メンバーなら誰でも）→ `{ ticket, expiresIn }`
- チケットの保存先は `TicketStore` インターフェースで抽象化し、Phase 2 ではプロセス内メモリで実装する（Phase 6 で Redis 版を追加する）。

## 2. メッセージ（§7.4 の JSON エンベロープ）
テキストフレームの JSON だけを受け付ける。1 メッセージの上限は **1 MiB**（`maxPayload`）。

| 方向 | type | 内容 |
|---|---|---|
| S→C | `session:ready` | 接続直後。`{ sessionId, userId, role, participants[] }` |
| S→C | `document:user_joined` / `document:user_left` | `{ participant }`（`sessionId, userId, displayName, role`） |
| C→S | `update:submit` | `{ updateId(UUID), payload(base64) }` |
| S→C | `update:broadcast` | `{ updateId, payload, from: { sessionId, userId } }` 送信者以外の同じ文書の接続へ |
| S→C | `session:role_changed` | `{ role }` 接続中に権限が変わった |
| S→C | `error` | `{ code, message, ref? }`（`ref` は原因になった updateId） |

- `session:ready` と `session:role_changed` は §7.3 の基本イベントに追加するもの。参加者一覧の初期状態と、接続中の降格を伝える手段が §7.3 になかったため。
- 参加者は**接続（タブ）単位**で数える。同じユーザーが 2 タブで開けば 2 件になり、`userId` が同じになる。
- 表示名と userId は**サーバーが DB から付与する**（R-12）。
- Phase 2 の `update:submit` は**中身を解釈せず中継する**だけ（ADR-0007）。保存しないので **`update:ack` は返さない**。ACK は「永続化完了」を意味するため（§7.6）、Phase 3 で保存と一緒に導入する。
- Viewer からの `update:submit` は中継せず、`error`（`FORBIDDEN`）を返す。
- `awareness:update`・`sync:*` は Phase 3 で追加する。それまでは `error`（`UNSUPPORTED_TYPE`）を返す。
- 不正な JSON・スキーマ違反は `error`（`INVALID_MESSAGE`）を返す。違反が 10 回を超えたら、またはメッセージ数が 10 秒あたり 200 件を超えたら、1008 で切断する。

## 3. 生存確認と寿命（§4.7, ADR-0005）
- サーバーは 30 秒ごとに ping を送り、次の ping までに pong がなければ切断する。
- 接続の最大寿命は 12 時間（ADR-0005）で、過ぎたら 4008 で閉じる。
- クライアントの自動再接続は `packages/client` に実装する（指数バックオフで、毎回新しいチケットを取る）。

## 4. 接続中の権限変更（R-13）
- REST の処理と WebSocket の接続は同じプロセスにあるので、Phase 2 では**プロセス内のイベントバス**（`AccessEvents`）で伝える。Phase 6 で Redis Pub/Sub に置き換える。
- 権限は**接続時と、イベントを受けたとき**に確認する。メッセージごとに DB を見ることはしない。

| イベント | 発生元 | 接続への影響 |
|---|---|---|
| `memberRoleChanged` | PATCH members | `session.role` を更新し、`session:role_changed` を送る |
| `memberRemoved` | DELETE members | そのユーザーの接続を 4003 で閉じる |
| `documentDeleted` | DELETE documents | その文書の全接続を 4004 で閉じる |
| `tokenFamilyRevoked` | logout、リフレッシュトークンの再利用検知 | その系列から発行されたチケットで張った接続を 4001 で閉じる |

- ログアウトした端末の接続だけを切るために、アクセストークンに `fid`（リフレッシュトークンの系列 ID）を入れる。チケットと接続はこの `fid` を引き継ぐ。

## 5. 独自のクローズコード
| コード | 意味 | クライアントの動作 |
|---|---|---|
| 4001 | ログアウト・トークン失効 | 再接続しない |
| 4003 | メンバーから外された | 再接続しない |
| 4004 | 文書が削除された | 再接続しない |
| 4008 | 最大寿命に達した | すぐ再接続する |
| 1008 / 1009 | ポリシー違反 / 大きすぎる | 再接続しない |
| 1001 | サーバーの停止 | バックオフして再接続する |
