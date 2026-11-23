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
