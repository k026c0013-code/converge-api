# ADR-0006: documents に engine と format_version を Phase 1 から持たせる

- 状態: 採用（2026-11-23、ユーザーが判断を委任「すべて君の感性に任せる」）
- 関連: レビュー R-06 / 要件定義書 §6, §8, Phase 8 / Phase 1

## 背景
payload は CRDT 固有のバイナリ形式で、クライアント（Tiptap + y-prosemirror）も Yjs に依存している。CRDTEngine インターフェースはサーバーしか抽象化していない。
そのため、Phase 7 で外部公開した後に Phase 8 でエンジンを差し替えると、既存の文書とクライアントの互換性が壊れる。

## 決定
- `documents` に次の2列を Phase 1 のスキーマから持たせる。
  - `engine VARCHAR(16) NOT NULL DEFAULT 'yjs'`
  - `format_version INT NOT NULL DEFAULT 1`
- エンジンは**文書単位で固定**する。作成時に決め、後から変えない（変換機能は作らない）。
- Phase 1〜7 で受け付ける値は `engine = 'yjs'`, `format_version = 1` だけ。API で指定させず、サーバーが既定値を入れる。
- サーバーは文書の `engine` を見て CRDTEngine の実装を選ぶ。未知の値の文書は開かずにエラーにする。

## 理由
- 後から列を足すと、公開済みデータの移行が必要になる。最初から持っていれば移行は不要で、費用はほぼない。
- 文書単位で固定すれば、Phase 8 の独自エンジンを既存の文書に影響させずに試せる。

## 未決定（Phase 8 着手前に決める推奨案）
- Phase 8 の独自 CRDT はまずプレーンテキストに限定する。用途はサーバー側の比較・テストにとどめ、ProseMirror バインディングは作らない。
