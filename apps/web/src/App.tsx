import { useEffect, useState } from 'react';

type Status = 'checking' | 'up' | 'down';

async function probe(path: string): Promise<Status> {
  try {
    const res = await fetch(path);
    return res.ok ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

const label: Record<Status, string> = { checking: '確認中…', up: '正常', down: '停止' };

/** Phase 0 placeholder: shows that web → API → database are wired together. */
export function App() {
  const [api, setApi] = useState<Status>('checking');
  const [db, setDb] = useState<Status>('checking');

  useEffect(() => {
    void probe('/api/v1/health').then(setApi);
    void probe('/api/v1/health/db').then(setDb);
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>Converge</h1>
      <ul>
        <li>API: <span data-testid="api-status">{label[api]}</span></li>
        <li>Database: <span data-testid="db-status">{label[db]}</span></li>
      </ul>
    </main>
  );
}
