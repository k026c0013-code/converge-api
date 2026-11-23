/**
 * Minimal REST client for the web app.
 * Tokens live in memory only (a reload signs you out). Storage policy is decided in Phase 3 (ADR-0008 §1).
 */

export interface User {
  id: string;
  email: string;
  displayName: string;
}

export interface DocumentInfo {
  id: string;
  title: string;
  myRole: 'owner' | 'editor' | 'viewer';
  updatedAt: string;
}

export interface VersionInfo {
  id: string;
  name: string;
  note: string | null;
  kind: 'manual' | 'pre_restore' | string;
  createdBy: string;
  createdAt: string;
}

export interface HistoryEntry {
  id: string;
  userId: string;
  displayName: string | null;
  size: number;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Seconds until a JWT's exp (0 if unreadable). Only for scheduling a refresh — the server still verifies. */
export function secondsLeft(jwt: string, now = Date.now()): number {
  try {
    const part = jwt.split('.')[1] ?? '';
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === 'number' ? exp - now / 1000 : 0;
  } catch {
    return 0;
  }
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export class Api {
  private tokens: Tokens | null = null;
  private refreshing: Promise<void> | null = null;
  onSignedOut: () => void = () => {};

  get signedIn(): boolean {
    return this.tokens !== null;
  }

  async register(email: string, password: string, displayName: string): Promise<User> {
    const body = await this.call<{ user: User; tokens: Tokens }>('POST', '/auth/register', { email, password, displayName }, false);
    this.tokens = body.tokens;
    return body.user;
  }

  async login(email: string, password: string): Promise<User> {
    const body = await this.call<{ user: User; tokens: Tokens }>('POST', '/auth/login', { email, password }, false);
    this.tokens = body.tokens;
    return body.user;
  }

  async logout(): Promise<void> {
    const t = this.tokens;
    this.tokens = null;
    if (t) await this.call('POST', '/auth/logout', { refreshToken: t.refreshToken }, false).catch(() => {});
  }

  /** A usable access token; refreshes first when it expires within a minute (used for WS tickets). */
  async accessToken(): Promise<string> {
    if (!this.tokens) throw new ApiError(401, 'UNAUTHORIZED', 'Not signed in');
    if (secondsLeft(this.tokens.accessToken) < 60) await this.refresh();
    return this.tokens!.accessToken;
  }

  listDocuments(): Promise<{ items: DocumentInfo[] }> {
    return this.call('GET', '/documents?limit=100');
  }

  createDocument(title: string): Promise<DocumentInfo> {
    return this.call('POST', '/documents', { title });
  }

  addMember(documentId: string, email: string, role: 'editor' | 'viewer'): Promise<unknown> {
    return this.call('POST', `/documents/${documentId}/members`, { email, role });
  }

  listVersions(documentId: string): Promise<{ items: VersionInfo[] }> {
    return this.call('GET', `/documents/${documentId}/versions`);
  }

  createVersion(documentId: string, name: string, note?: string): Promise<VersionInfo> {
    return this.call('POST', `/documents/${documentId}/versions`, note ? { name, note } : { name });
  }

  getVersion(documentId: string, versionId: string): Promise<{ version: VersionInfo; state: string; content: string }> {
    return this.call('GET', `/documents/${documentId}/versions/${versionId}`);
  }

  restore(documentId: string, versionId: string): Promise<{ restoredVersionId: string; preRestoreVersionId: string }> {
    return this.call('POST', `/documents/${documentId}/restore`, { versionId });
  }

  history(documentId: string): Promise<{ items: HistoryEntry[] }> {
    return this.call('GET', `/documents/${documentId}/history?limit=20`);
  }

  private async refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const t = this.tokens;
        if (!t) throw new ApiError(401, 'UNAUTHORIZED', 'Not signed in');
        const next = await this.call<Tokens>('POST', '/auth/refresh', { refreshToken: t.refreshToken }, false);
        this.tokens = { accessToken: next.accessToken, refreshToken: next.refreshToken };
      } catch (err) {
        this.tokens = null;
        this.onSignedOut();
        throw err;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async call<T>(method: string, path: string, body?: unknown, auth = true, retried = false): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && this.tokens) headers.authorization = `Bearer ${this.tokens.accessToken}`;
    const res = await fetch(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401 && auth && !retried && this.tokens) {
      await this.refresh();
      return this.call(method, path, body, auth, true);
    }
    if (res.status === 204) return undefined as T;
    const json = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
    if (!res.ok) throw new ApiError(res.status, json.error?.code ?? 'ERROR', json.error?.message ?? res.statusText);
    return json as T;
  }
}
