# ADR-0002: データベースを PostgreSQL から MySQL 8.0 に変更

- 状態: 採用（2026-11-23、ユーザー指示「データベースはMySQLでいいです。もうはいってるので」）
- 変更対象: 要件定義書 §5.3（PostgreSQL は「第一候補」）、§7.6, §8 の型名、§14 Phase 0 の「Docker Compose設定 / PostgreSQL起動」

## 決定
- ローカルにインストール済みの MySQL 8.0.46（Windows サービス `MySQL80`）を使う。
- 専用ユーザー `converge@localhost` を作成。権限は `converge_dev` / `converge_test` / `converge_shadow` の3DBに限定（root はアプリから使わない）。
- Prisma の provider は `mysql`。Prisma 7 のドライバーアダプターは `@prisma/adapter-mariadb`（MySQL 8 で動作確認済み）。
- Phase 0 の Docker Compose は **保留**。DB 起動に不要になったため。Phase 6（Redis）/ Phase 7（Docker化）で導入する。

## 要件定義書の型の読み替え（Phase 1 の設計で確定させる推奨案）
| 要件定義書 (PostgreSQL) | MySQL での推奨 | 注意点 |
|---|---|---|
| UUID | `CHAR(36)`（Prisma `String @db.Char(36)`） | ネイティブ型なし。性能が問題になれば `BINARY(16)` を検討 |
| BYTEA | `LONGBLOB`（Prisma `Bytes`） | 1行の大きさは `max_allowed_packet`（既定 64MB）が上限。スナップショットの肥大化に注意 |
| TIMESTAMP | `DATETIME(3)`（Prisma の既定） | MySQL の TIMESTAMP は 2038年問題があるため使わない。UTC で保存する |
| BIGINT 連番 | `BIGINT AUTO_INCREMENT` | |
| `ON CONFLICT DO NOTHING`（重複確認） | `INSERT ... ON DUPLICATE KEY UPDATE id = id` | `INSERT IGNORE` は重複以外のエラーも握りつぶすので使わない |

## 影響・リスク
- 照合順序 `utf8mb4_0900_ai_ci` は大文字小文字・アクセントを区別しない。email の一意制約は大文字小文字を区別せずに判定される（望ましい動作）。区別が必要な列は `utf8mb4_bin` を明示する。
- 既定の分離レベルは REPEATABLE READ。Phase 1 で権限変更など競合しうる処理を設計するときに考慮する。
- 本番（Phase 7）はマネージド MySQL（各クラウドにある）を前提にする。配置先は未決定事項7のまま。
- ローカル接続は TLS なし（`allowPublicKeyRetrieval: true` は開発時のみ）。本番は TLS 必須（§13）。
