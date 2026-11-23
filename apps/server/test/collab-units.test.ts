import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseClientMessage } from '../src/collab/protocol.js';
import { MemoryTicketStore } from '../src/collab/tickets.js';

describe('parseClientMessage', () => {
  const id = randomUUID();

  it('accepts a well-formed update:submit', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'update:submit', updateId: id, payload: 'AQID' }))).toEqual({
      ok: true,
      message: { type: 'update:submit', updateId: id, payload: 'AQID' },
    });
  });

  it.each([
    ['not JSON', '{', 'INVALID_MESSAGE'],
    ['an array', '[]', 'INVALID_MESSAGE'],
    ['unknown type', JSON.stringify({ type: 'hack' }), 'UNSUPPORTED_TYPE'],
    ['awareness (Phase 3)', JSON.stringify({ type: 'awareness:update' }), 'UNSUPPORTED_TYPE'],
    ['non-uuid updateId', JSON.stringify({ type: 'update:submit', updateId: 'upd_001', payload: 'AQID' }), 'INVALID_MESSAGE'],
    ['non-base64 payload', JSON.stringify({ type: 'update:submit', updateId: id, payload: '***' }), 'INVALID_MESSAGE'],
    ['empty payload', JSON.stringify({ type: 'update:submit', updateId: id, payload: '' }), 'INVALID_MESSAGE'],
    ['extra property', JSON.stringify({ type: 'update:submit', updateId: id, payload: 'AQID', userId: 'x' }), 'INVALID_MESSAGE'],
  ])('rejects %s', (_name, raw, code) => {
    const r = parseClientMessage(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });

  it('echoes a valid updateId as ref when the rest is invalid', () => {
    const r = parseClientMessage(JSON.stringify({ type: 'update:submit', updateId: id, payload: '***' }));
    expect(r).toMatchObject({ ok: false, ref: id });
  });
});

describe('MemoryTicketStore', () => {
  const claims = { userId: 'u', documentId: 'd', familyId: 'f' };

  it('is single-use', async () => {
    const store = new MemoryTicketStore();
    const { ticket, expiresIn } = await store.issue(claims);
    expect(expiresIn).toBe(30);
    expect(await store.consume(ticket)).toEqual(claims);
    expect(await store.consume(ticket)).toBeNull();
  });

  it('expires after the TTL and sweeps stale entries', async () => {
    let now = 1_000;
    const store = new MemoryTicketStore(30_000, () => now);
    const { ticket } = await store.issue(claims);
    now += 30_000;
    expect(await store.consume(ticket)).toBeNull();
    await store.issue(claims);
    now += 31_000;
    await store.issue(claims); // sweeps the previous one
    expect(store.size).toBe(1);
  });

  it('rejects unknown tickets', async () => {
    expect(await new MemoryTicketStore().consume('nope')).toBeNull();
  });
});
