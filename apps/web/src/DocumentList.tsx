import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, type Api, type DocumentInfo } from './api';

export function DocumentList({ api, onOpen }: { api: Api; onOpen: (d: DocumentInfo) => void }) {
  const [docs, setDocs] = useState<DocumentInfo[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDocs((await api.listDocuments()).items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '読み込めませんでした');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      await api.createDocument(title);
      setTitle('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '作成できませんでした');
    }
  }

  return (
    <section>
      <h2>ドキュメント</h2>
      <form onSubmit={create} style={{ display: 'flex', gap: 8 }}>
        <input aria-label="新しいドキュメントのタイトル" placeholder="タイトル" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
        <button type="submit">作成</button>
      </form>
      {error && <p role="alert" style={{ color: '#b00020' }}>{error}</p>}
      <ul>
        {docs.map((d) => (
          <li key={d.id}>
            <button type="button" onClick={() => onOpen(d)}>{d.title}</button> <small>（{d.myRole}）</small>
          </li>
        ))}
      </ul>
      {docs.length === 0 && <p>まだありません。</p>}
    </section>
  );
}
