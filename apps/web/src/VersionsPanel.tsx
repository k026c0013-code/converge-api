import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { ApiError, type Api, type HistoryEntry, type VersionInfo } from './api';
import { Editor } from './Editor';

type Role = 'owner' | 'editor' | 'viewer';

const fmt = (iso: string) => new Date(iso).toLocaleString();

function decodeState(b64: string): Y.Doc {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return doc;
}

/** Versions, past-state preview, restore and the update log (requirements §4.6, ADR-0012). */
export function VersionsPanel({ api, documentId, role }: { api: Api; documentId: string; role: Role }) {
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [name, setName] = useState('');
  const [preview, setPreview] = useState<{ version: VersionInfo; doc: Y.Doc; awareness: Awareness } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [v, h] = await Promise.all([api.listVersions(documentId), api.history(documentId)]);
      setVersions(v.items);
      setHistory(h.items);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : '履歴を読み込めませんでした');
    }
  }, [api, documentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api.createVersion(documentId, name);
      setName('');
      setMessage('バージョンを保存しました');
      await reload();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : '保存できませんでした');
    }
  }

  async function show(v: VersionInfo) {
    try {
      const res = await api.getVersion(documentId, v.id);
      const doc = decodeState(res.state);
      setPreview({ version: v, doc, awareness: new Awareness(doc) });
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : '読み込めませんでした');
    }
  }

  async function restore(v: VersionInfo) {
    setConfirming(null);
    try {
      await api.restore(documentId, v.id);
      setMessage(`「${v.name}」に復元しました（復元前の状態もバージョンとして保存されています）`);
      setPreview(null);
      await reload();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : '復元できませんでした');
    }
  }

  return (
    <section aria-label="バージョン">
      <h3>バージョン</h3>
      {message && <p>{message}</p>}
      {role !== 'viewer' && (
        <form onSubmit={save} style={{ display: 'flex', gap: 8 }}>
          <input aria-label="バージョン名" placeholder="バージョン名" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
          <button type="submit">この状態を保存</button>
        </form>
      )}
      <ul>
        {versions.map((v) => (
          <li key={v.id}>
            <strong>{v.name}</strong> <small>{fmt(v.createdAt)}{v.kind === 'pre_restore' && '（自動保存）'}</small>{' '}
            <button type="button" onClick={() => void show(v)}>表示</button>
            {role === 'owner' &&
              (confirming === v.id ? (
                <>
                  {' '}
                  <button type="button" onClick={() => void restore(v)}>本当に復元する</button>
                  <button type="button" onClick={() => setConfirming(null)}>やめる</button>
                </>
              ) : (
                <>
                  {' '}
                  <button type="button" onClick={() => setConfirming(v.id)}>復元</button>
                </>
              ))}
          </li>
        ))}
      </ul>
      {versions.length === 0 && <p>まだありません。</p>}

      {preview && (
        <div>
          <h4>「{preview.version.name}」の内容 <button type="button" onClick={() => setPreview(null)}>閉じる</button></h4>
          <Editor doc={preview.doc} awareness={preview.awareness} editable={false} userName="" />
        </div>
      )}

      <h3>編集履歴（最新 20 件）</h3>
      <button type="button" onClick={() => void reload()}>更新</button>
      <ul>
        {history.map((h) => (
          <li key={h.id}>
            {fmt(h.createdAt)} — {h.displayName ?? h.userId} <small>（{h.size} バイト）</small>
          </li>
        ))}
      </ul>
    </section>
  );
}
