import { ConvergeConnection, type Participant, type Role, type Status, type StopReason } from '@converge/client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, type Api, type DocumentInfo } from './api';

const statusLabel: Record<Status, string> = {
  idle: '待機中',
  connecting: '接続中…',
  open: '接続済み',
  reconnecting: '再接続中…',
  closed: '切断',
};

const stopLabel: Record<StopReason, string> = {
  closed_by_client: '閉じました',
  signed_out: 'ログアウトしたため切断しました',
  access_revoked: 'このドキュメントへのアクセス権がなくなりました',
  document_deleted: 'このドキュメントは削除されました',
  unauthorized: 'ログインし直してください',
  policy_violation: 'サーバーが接続を拒否しました',
};

interface Relayed {
  key: string;
  from: string;
  text: string;
}

/**
 * Phase 2 document room: presence and an opaque relay check (ADR-0007).
 * The rich-text editor and cursors arrive in Phase 3.
 */
export function DocumentRoom({ api, doc, onBack }: { api: Api; doc: DocumentInfo; onBack: () => void }) {
  const [status, setStatus] = useState<Status>('idle');
  const [role, setRole] = useState<Role | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [relayed, setRelayed] = useState<Relayed[]>([]);
  const [stopped, setStopped] = useState<StopReason | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [memberEmail, setMemberEmail] = useState('');
  const [memberRole, setMemberRole] = useState<'editor' | 'viewer'>('editor');
  const connRef = useRef<ConvergeConnection | null>(null);
  const namesRef = useRef(new Map<string, string>());

  useEffect(() => {
    const conn = new ConvergeConnection({ documentId: doc.id, getAccessToken: () => api.accessToken() });
    connRef.current = conn;
    conn.on('status', setStatus);
    conn.on('ready', (r) => setRole(r.role));
    conn.on('roleChanged', setRole);
    conn.on('participants', (ps) => {
      for (const p of ps) namesRef.current.set(p.userId, p.displayName);
      setParticipants(ps);
    });
    conn.on('update', (u) =>
      setRelayed((list) => [
        ...list.slice(-19),
        { key: u.updateId, from: namesRef.current.get(u.from.userId) ?? u.from.userId, text: new TextDecoder().decode(u.payload) },
      ]),
    );
    conn.on('serverError', (e) => setNotice(e.code === 'FORBIDDEN' ? '閲覧者は送信できません' : e.message));
    conn.on('stopped', setStopped);
    conn.connect();
    return () => conn.close();
  }, [api, doc.id]);

  function send(e: FormEvent) {
    e.preventDefault();
    if (connRef.current?.sendUpdate(new TextEncoder().encode(text))) setText('');
  }

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

  return (
    <section>
      <button type="button" onClick={onBack}>← 一覧へ</button>
      <h2>{doc.title}</h2>
      <p>
        状態: <strong data-testid="conn-status">{statusLabel[status]}</strong>
        {role && <> ／ あなたの権限: {role}</>}
      </p>
      {stopped && stopped !== 'closed_by_client' && <p role="alert" style={{ color: '#b00020' }}>{stopLabel[stopped]}</p>}
      {notice && <p>{notice}</p>}

      <h3>参加中（{participants.length}）</h3>
      <ul data-testid="participants">
        {participants.map((p) => (
          <li key={p.sessionId}>
            {p.displayName} <small>（{p.role}）</small>
          </li>
        ))}
      </ul>

      <h3>中継テスト</h3>
      <p style={{ fontSize: 13, color: '#666' }}>
        Phase 2 は中身を解釈せずに他の参加者へ届けるだけです（保存はされません）。エディタは Phase 3 で入ります。
      </p>
      <form onSubmit={send} style={{ display: 'flex', gap: 8 }}>
        <input aria-label="送るテキスト" value={text} onChange={(e) => setText(e.target.value)} required disabled={status !== 'open'} />
        <button type="submit" disabled={status !== 'open' || role === 'viewer'}>送信</button>
      </form>
      <ul>
        {relayed.map((r) => (
          <li key={r.key}>
            <strong>{r.from}</strong>: {r.text}
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
