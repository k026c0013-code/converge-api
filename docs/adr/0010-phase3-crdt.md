# ADR-0010: Phase 3 の CRDT（Yjs）同期・永続化・更新検証

- 状態: 採用（2026-11-23、ユーザーが判断を委任「承認なしに進め続けていい」）
- 関連: ADR-0003（保存してから適用）, ADR-0004（ルートは `content` のみ）, ADR-0006（engine 列）, ADR-0009（プロトコル）, レビュー R-03, R-10, R-12, R-15, R-17 / 要件定義書 §4.3〜4.4, §6, §7, §8.4, §13, §15 / Phase 3

## 1. CRDTEngine（§6.2）
- `apps/server/src/crdt/engine.ts` に `CRDTEngine` インターフェースを置き、`YjsEngine` を実装する。文書の `engine` 列（ADR-0006）で実装を選ぶ。
- §6.2 の 5 つのメソッドに、次の 1 つを追加する。
  - `validateUpdate(update): { ok: true } | { ok: false, reason }` — R-03 の検証。ライブ文書には触れない。

## 2. 更新の検証（R-03, §13「CRDTを利用していることを理由に、更新データを無条件に信用してはならない」）
`update:submit` ごとに、次の順で確認する。どれかに引っかかったら保存も配信もしない。
1. **権限**: Viewer なら `FORBIDDEN`（ADR-0009）
2. **大きさ**: デコード後 512 KiB まで（フレームは 1 MiB）→ `UPDATE_TOO_LARGE`
3. **形式**: `Y.decodeUpdate` で構造を読む。例外が出たら → `INVALID_UPDATE`
4. **ルート名**: ルートに直接ぶら下がる要素（parent が文字列のもの）は、`content` 以外を拒否する（ADR-0004）→ `FORBIDDEN_ROOT`。入れ子の要素は既存の要素を親に持つので、ルートを制限すれば全体が `content` の内側に限られる。

**限界（明記しておく）**: `content` の内側の意味（ProseMirror のスキーマに合うか）までは検証しない。スキーマに合わない要素は y-prosemirror の側で無視・補正される。文書全体の大きさの上限は Phase 5 のスナップショットと一緒に決める。

## 3. 永続化（§8.4, ADR-0003）
- `document_updates`: `id BIGINT AUTO_INCREMENT`, `document_id`, `update_id CHAR(36)`, `client_id VARCHAR(64)`（送信した接続の sessionId）, `user_id`, `update_data LONGBLOB`, `created_at`。`UNIQUE(document_id, update_id)`
- 書き込みは `INSERT … ON DUPLICATE KEY UPDATE id = id` を `$executeRaw` で行う（R-17）。影響行数が 0 なら重複（CT-05）。
- 処理順（ADR-0003）: 検証 → INSERT → Commit → ライブ文書へ適用 → `update:ack` → 他の接続へ `update:broadcast`。重複は ACK だけを返す。INSERT が失敗したら `error`（`PERSIST_FAILED`, `ref`）を返し、反映も配信もしない。
- 文書ごとに処理を**直列化**する（Promise のキュー）。保存の順序と、ライブ文書へ適用する順序をそろえるため。
- **ライブ文書**: 最初の接続で、`document_updates` を id 順にすべて適用して作る。最後の接続が切れてから 30 秒後にメモリから外す。スナップショット（R-15 の圧縮）は Phase 5 で作る。それまでは読み込み時間が更新件数に比例する。
- CT-07（再起動後の復元）は、この「DB から作り直す」動作で満たす。

## 4. プロトコルの追加（§7.3）
| 方向 | type | 内容 |
|---|---|---|
| C→S | `sync:request` | `{ stateVector }`（base64） |
| S→C | `sync:response` | `{ update, stateVector }` クライアントに足りない差分と、サーバーの state vector |
| S→C | `sync:complete` | `sync:response` の直後に送る（初期同期が終わった合図） |
| S→C | `update:ack` | `{ updateId }` 永続化が終わった（§7.6） |
| C↔S | `awareness:update` | `{ payload }`（y-protocols の awareness 更新, base64）。永続化しない（§7.5） |

- **再接続時の取りこぼし回復（R-10 の推奨案を採用）**: クライアントは `sync:response` の state vector から「サーバーにない自分の差分」を作り、新しい updateId で `update:submit` する。未送信の更新を 1 件ずつ管理するキューは持たない。二重反映は CRDT の冪等性で防ぎ、`(document_id, update_id)` のユニーク制約は「同じ送信の再試行」の検出に使う。
- Phase 2 の `update:broadcast` の `payload` は Yjs の更新になる。中継（解釈しない）は Phase 3 で廃止する。

## 5. Awareness（R-12）
- サーバーは awareness 更新をデコードし、各状態の `user` を **`{ name: 表示名, color: userId から決めた色, userId }` で上書き**してから配信する。
- 1 つの接続が使える awareness の clientID は、最初に送ってきた 1 つだけ。他の clientID の状態は捨てる（他人のカーソルの偽装を防ぐ）。
- 接続が切れたら、その clientID の削除（state = null）をサーバーが他の接続へ配信する。
- Viewer も awareness は送れる（カーソル・選択範囲の表示は閲覧の一部）。

## 6. クライアントとエディタ
- `@converge/client` に `YjsSync`（Y.Doc と Awareness を `ConvergeConnection` に結び付ける）を追加する。リモートから来た更新は origin `'remote'` で適用し、送り返さない。
- Web は Tiptap 3（`StarterKit`、Collaboration の `field: 'content'`、CollaborationCaret）。要件 §4.3 の見出し・箇条書き・番号付きリスト・太字・斜体のツールバーを付ける。Undo は Collaboration 側の Undo を使う。
- Viewer のエディタは読み取り専用にする（サーバーも拒否する）。

## 7. テスト（§15）
- CT-01〜04: 複数の Y.Doc をサーバー経由・順序を入れ替えて同期し、状態の一致を確認する。
- CT-05: 同じ updateId の再送で行が増えず、二重配信されない。
- CT-07: アプリを作り直しても（再起動の代わり）、DB から同じ状態を復元できる。
- CT-08: Viewer の更新は保存も配信もされない。
- Property-based Testing（fast-check）: ランダムな操作列とランダムな配送順でも、全クライアントが収束する。
