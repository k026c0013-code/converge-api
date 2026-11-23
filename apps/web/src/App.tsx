import { useMemo, useState } from 'react';
import { Api, type DocumentInfo, type User } from './api';
import { AuthForm } from './AuthForm';
import { DocumentList } from './DocumentList';
import { DocumentRoom } from './DocumentRoom';
import { HealthPanel } from './HealthPanel';

export function App() {
  const api = useMemo(() => new Api(), []);
  const [user, setUser] = useState<User | null>(null);
  const [doc, setDoc] = useState<DocumentInfo | null>(null);
  api.onSignedOut = () => {
    setUser(null);
    setDoc(null);
  };

  async function logout() {
    await api.logout();
    setUser(null);
    setDoc(null);
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24, maxWidth: 720 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h1>Converge</h1>
        {user && (
          <span>
            {user.displayName} <button type="button" onClick={() => void logout()}>ログアウト</button>
          </span>
        )}
      </header>
      <HealthPanel />
      {!user && <AuthForm api={api} onSignedIn={setUser} />}
      {user && !doc && <DocumentList api={api} onOpen={setDoc} />}
      {user && doc && <DocumentRoom key={doc.id} api={api} doc={doc} onBack={() => setDoc(null)} />}
    </main>
  );
}
