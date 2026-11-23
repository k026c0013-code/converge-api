import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api, ApiError, secondsLeft } from './api';

const jwt = (exp: number) => `h.${btoa(JSON.stringify({ exp })).replace(/=+$/, '')}.s`;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const tokens = (n: number, exp = Date.now() / 1000 + 900) => ({ accessToken: jwt(exp) + n, refreshToken: `r${n}` });

afterEach(() => vi.unstubAllGlobals());

async function signedIn(fetchMock: ReturnType<typeof vi.fn>, t = tokens(1)) {
  fetchMock.mockResolvedValueOnce(json(200, { user: { id: 'u', email: 'a@b.c', displayName: 'A' }, tokens: t }));
  const api = new Api();
  await api.login('a@b.c', 'pw');
  return api;
}

describe('secondsLeft', () => {
  it('reads exp from a JWT and returns 0 for garbage', () => {
    expect(secondsLeft(jwt(1_000), 900_000)).toBe(100);
    expect(secondsLeft('garbage')).toBe(0);
  });
});

describe('Api', () => {
  it('refreshes once on 401 and retries the request with the new token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const api = await signedIn(fetchMock);
    const next = tokens(2);
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }))
      .mockResolvedValueOnce(json(200, { tokenType: 'Bearer', expiresIn: 900, ...next }))
      .mockResolvedValueOnce(json(200, { items: [] }));

    await expect(api.listDocuments()).resolves.toEqual({ items: [] });
    const [, refreshCall, retry] = fetchMock.mock.calls.slice(1);
    expect(refreshCall?.[0]).toBe('/api/v1/auth/refresh');
    expect(JSON.parse(String(refreshCall?.[1].body))).toEqual({ refreshToken: 'r1' });
    expect(retry?.[1].headers.authorization).toBe(`Bearer ${next.accessToken}`);
  });

  it('signs out when the refresh fails', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const api = await signedIn(fetchMock);
    const onSignedOut = vi.fn();
    api.onSignedOut = onSignedOut;
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }))
      .mockResolvedValueOnce(json(401, { error: { code: 'INVALID_REFRESH_TOKEN', message: 'x' } }));
    await expect(api.listDocuments()).rejects.toBeInstanceOf(ApiError);
    expect(onSignedOut).toHaveBeenCalled();
    expect(api.signedIn).toBe(false);
  });

  it('accessToken() refreshes a token that is about to expire', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const api = await signedIn(fetchMock, tokens(1, Date.now() / 1000 + 30));
    const next = tokens(2);
    fetchMock.mockResolvedValueOnce(json(200, { tokenType: 'Bearer', expiresIn: 900, ...next }));
    await expect(api.accessToken()).resolves.toBe(next.accessToken);
  });

  it('surfaces API error codes and messages', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' } }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await new Api().login('a@b.c', 'bad').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' });
  });
});
