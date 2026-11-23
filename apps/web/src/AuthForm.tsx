import { useState, type FormEvent } from 'react';
import { ApiError, type Api, type User } from './api';

export function AuthForm({ api, onSignedIn }: { api: Api; onSignedIn: (u: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = mode === 'login' ? await api.login(email, password) : await api.register(email, password, displayName);
      onSignedIn(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'サーバーに接続できません');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 8, maxWidth: 320 }}>
      <h2>{mode === 'login' ? 'ログイン' : 'アカウント作成'}</h2>
      <input aria-label="メールアドレス" type="email" placeholder="メールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input aria-label="パスワード" type="password" placeholder="パスワード（8文字以上）" value={password} onChange={(e) => setPassword(e.target.value)} required />
      {mode === 'register' && (
        <input aria-label="表示名" placeholder="表示名" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={50} />
      )}
      <button type="submit" disabled={busy}>{mode === 'login' ? 'ログイン' : '作成'}</button>
      {error && <p role="alert" style={{ color: '#b00020' }}>{error}</p>}
      <button type="button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'アカウントを作る' : 'ログインに戻る'}
      </button>
    </form>
  );
}
