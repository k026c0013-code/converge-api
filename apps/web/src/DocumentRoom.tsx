import { ConvergeConnection, YjsSync, type Participant, type Role, type Status, type StopReason, type SyncState } from '@converge/client';
import { useEffect, useState, type FormEvent } from 'react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { ApiError, type Api, type DocumentInfo, type User } from './api';
import { Editor } from './Editor';
import { VersionsPanel } from './VersionsPanel';
import { dirtyStore, discardLocal, openLocal } from './offline';

const statusLabel: Record<Status, string> = {
  idle: '待機中',
  connecting: '接続中…',
  open: '接続済み',
  reconnecting: '再接続中…',
  closed: '切断',
};

const syncLabel: Record<SyncState, string> = { offline: 'オフライン', syncing: '同期中…', synced: '同期済み' };

const stopLabel: Record<StopReason, string> = {
  closed_by_client: '閉じました',
  signed_out: 'ログアウトしたため切断しました',
  access_revoked: 'このドキュメントへのアクセス権がなくなりました',
  document_deleted: 'このドキュメントは削除されました',
  unauthorized: 'ログインし直してください',
  policy_violation: 'サーバーが接続を拒否しました',
};

/** Document room: collaborative editor, presence and sync status (Phase 3, ADR-0010). */
export function DocumentRoom({ api, user, doc, onBack }: { api: Api; user: User; doc: DocumentInfo; onBack: () => void }) {
  const [status, setStatus] = useState<Status>('idle');
  const [sync, setSync] = useState<{ state: SyncState; pending: number; dirty: boolean }>({ state: 'offline', pending: 0, dirty: false });
  const [role, setRole] = useState<Role | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [stopped, setStopped] = useState<StopReason | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState<'editor' | 'viewer'>('editor');

  // One Y.Doc + Awareness per effect run (StrictMode-safe: each run owns and destroys its own).
  const [shared, setShared] = useState<{ ydoc: Y.Doc; awareness: Awareness } | null>(null);

  useEffect(() => {
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    let disposed = false;
    let cleanup = () => {};

    // Load the local IndexedDB copy first, so offline edits go out with the first sync (ADR-0011 §1).
    void openLocal(user.id, doc.id, ydoc).then(
      (persistence) => {
        if (disposed) {
          void persistence.destroy();
          return;
        }
        setShared({ ydoc, awareness });
        const conn = new ConvergeConnection({ documentId: doc.id, getAccessToken: () => api.accessToken() });
        const yjs = new YjsSync(conn, ydoc, awareness, { dirtyStore: dirtyStore(user.id, doc.id) });
        conn.on('status', setStatus);
        conn.on('ready', (r) => setRole(r.role));
        conn.on('roleChanged', setRole);
        conn.on('participants', setParticipants);
        conn.on('serverError', (e) => setNotice(e.code === 'FORBIDDEN' ? '閲覧者は編集できません' : e.message));
        conn.on('stopped', (reason) => {
          setStopped(reason);
          if (reason === 'document_deleted' || reason === 'access_revoked') {
            // Nowhere left to send local changes: drop the copy and say so if anything was unsaved.
            if (yjs.dirty) setNotice('保存されていない変更がありましたが、送信先がなくなったため破棄しました');
            void persistence.destroy().then(() => discardLocal(user.id, doc.id));
          }
        });
        yjs.onChange((state, pending, dirty) => setSync({ state, pending, dirty }));
        setSync({ state: yjs.state, pending: 0, dirty: yjs.dirty });
        conn.connect();
        cleanup = () => {
          yjs.destroy();
          conn.close();
          void persistence.destroy();
        };
      },
      () => setNotice('この端末に文書を保存できません（IndexedDB が使えません）'),
    );

    return () => {
      disposed = true;
      cleanup();
      awareness.destroy();
      ydoc.destroy();
    };
  }, [api, user.id, doc.id]);

  async function addMember(e: FormEvent) {
    e.preventDefault();
    try {
      await api.addMember(doc.id, memberEmail, memberRole);
      setMemberEmail('');
      setNotice('メンバーを追加しました');
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : '追加できませんでした');
    }
  }

  // Keep editing through connection drops; viewers never edit (ADR-0011 §4).
  const effectiveRole = role ?? doc.myRole;
  const editable = effectiveRole !== 'viewer' && stopped === null;

  return (
    <section>
      <button type="button" onClick={onBack}>← 一覧へ</button>
      <h2>{doc.title}</h2>
      <p>
        接続: <strong data-testid="conn-status">{statusLabel[status]}</strong> ／ 同期:{' '}
        <strong data-testid="sync-status">
          {syncLabel[sync.state]}
          {sync.pending > 0 && `（保存待ち ${sync.pending}）`}
          {sync.state === 'offline' && sync.dirty && '（未送信の変更あり）'}
        </strong>
        {role && <> ／ あなたの権限: {role}</>}
      </p>
      {stopped && stopped !== 'closed_by_client' && <p role="alert" style={{ color: '#b00020' }}>{stopLabel[stopped]}</p>}
      {notice && <p>{notice}</p>}

      {shared && <Editor doc={shared.ydoc} awareness={shared.awareness} editable={editable} userName={user.displayName} />}

      <VersionsPanel api={api} documentId={doc.id} role={effectiveRole} />

      <h3>参加中（{participants.length}）</h3>
      <ul data-testid="participants">
        {participants.map((p) => (
          <li key={p.sessionId}>
            {p.displayName} <small>（{p.role}）</small>
          </li>
        ))}
      </ul>

      {doc.myRole === 'owner' && (
        <>
          <h3>メンバーを追加</h3>
          <form onSubmit={addMember} style={{ display: 'flex', gap: 8 }}>
            <input aria-label="追加するメールアドレス" type="email" value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} required />
            <select aria-label="権限" value={memberRole} onChange={(e) => setMemberRole(e.target.value as 'editor' | 'viewer')}>
              <option value="editor">editor</option>
              <option value="viewer">viewer</option>
            </select>
            <button type="submit">追加</button>
          </form>
        </>
      )}
    </section>
  );
}
