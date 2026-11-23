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

/** Shows that web → API → database are wired together. */
export function HealthPanel() {
  const [api, setApi] = useState<Status>('checking');
  const [db, setDb] = useState<Status>('checking');

  useEffect(() => {
    void probe('/api/v1/health').then(setApi);
    void probe('/api/v1/health/db').then(setDb);
  }, []);

  return (
    <p style={{ fontSize: 13, color: '#666' }}>
      API: <span data-testid="api-status">{label[api]}</span> ／ Database: <span data-testid="db-status">{label[db]}</span>
    </p>
  );
}
