import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App health panel', () => {
  it('shows both services up when the API answers 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('api-status').textContent).toBe('正常'));
    expect(screen.getByTestId('db-status').textContent).toBe('正常');
  });

  it('shows the database down when /health/db answers 503', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      new Response('{}', { status: String(input).endsWith('/db') ? 503 : 200 })));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('db-status').textContent).toBe('停止'));
    expect(screen.getByTestId('api-status').textContent).toBe('正常');
  });

  it('shows both down when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('api-status').textContent).toBe('停止'));
    expect(screen.getByTestId('db-status').textContent).toBe('停止');
  });
});

describe('App sign-in flow', () => {
  it('logs in and shows the document list', async () => {
    const { fireEvent } = await import('@testing-library/react');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/login')) {
        return new Response(JSON.stringify({
          user: { id: 'u1', email: 'a@example.test', displayName: 'Alice' },
          tokens: { tokenType: 'Bearer', accessToken: 'h.e30.s', refreshToken: 'r', expiresIn: 900 },
        }), { status: 200 });
      }
      if (url.includes('/documents')) {
        return new Response(JSON.stringify({ items: [{ id: 'd1', title: '議事録', myRole: 'owner', updatedAt: '' }], nextCursor: null }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }));
    render(<App />);
    fireEvent.change(screen.getByLabelText('メールアドレス'), { target: { value: 'a@example.test' } });
    fireEvent.change(screen.getByLabelText('パスワード'), { target: { value: 'password123' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'ログイン' })[0]!);
    await waitFor(() => expect(screen.getByText('議事録')).toBeTruthy());
    expect(screen.getByText(/Alice/)).toBeTruthy();
  });
});
