/** Wire format for /ws/documents/{id} (ADR-0009 §2, ADR-0010 §4). JSON text frames only. */

export type SessionRole = 'owner' | 'editor' | 'viewer';

export interface Participant {
  sessionId: string;
  userId: string;
  displayName: string;
  role: SessionRole;
}

export type ServerMessage =
  | { type: 'session:ready'; sessionId: string; userId: string; role: SessionRole; participants: Participant[] }
  | { type: 'document:user_joined'; participant: Participant }
  | { type: 'document:user_left'; participant: Participant }
  | { type: 'sync:response'; update: string; stateVector: string }
  | { type: 'sync:complete' }
  | { type: 'update:ack'; updateId: string }
  | { type: 'update:broadcast'; updateId: string; payload: string; from: { sessionId: string; userId: string } }
  | { type: 'awareness:update'; payload: string }
  | { type: 'session:role_changed'; role: SessionRole }
  | { type: 'error'; code: string; message: string; ref?: string };

export type ClientMessage =
  | { type: 'update:submit'; updateId: string; payload: string }
  | { type: 'sync:request'; stateVector: string }
  | { type: 'awareness:update'; payload: string };

export const CloseCode = {
  goingAway: 1001,
  policyViolation: 1008,
  tooBig: 1009,
  tokenRevoked: 4001,
  accessRevoked: 4003,
  documentDeleted: 4004,
  sessionExpired: 4008,
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: 'INVALID_MESSAGE' | 'UNSUPPORTED_TYPE'; message: string; ref?: string };

const invalid = (message: string, ref?: string): ParseResult =>
  ref ? { ok: false, code: 'INVALID_MESSAGE', message, ref } : { ok: false, code: 'INVALID_MESSAGE', message };

function exactKeys(m: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(m);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

const isB64 = (v: unknown, allowEmpty = false): v is string =>
  typeof v === 'string' && (allowEmpty || v.length > 0) && BASE64_RE.test(v);

export function parseClientMessage(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return invalid('Message is not valid JSON');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return invalid('Message must be a JSON object');
  const m = data as Record<string, unknown>;

  switch (m.type) {
    case 'update:submit': {
      const ref = typeof m.updateId === 'string' && isUuid(m.updateId) ? m.updateId : undefined;
      if (!exactKeys(m, ['type', 'updateId', 'payload'])) return invalid('update:submit takes exactly type, updateId and payload', ref);
      if (!ref) return invalid('updateId must be a UUID');
      if (!isB64(m.payload)) return invalid('payload must be non-empty base64', ref);
      return { ok: true, message: { type: 'update:submit', updateId: ref, payload: m.payload } };
    }
    case 'sync:request':
      if (!exactKeys(m, ['type', 'stateVector'])) return invalid('sync:request takes exactly type and stateVector');
      if (!isB64(m.stateVector, true)) return invalid('stateVector must be base64');
      return { ok: true, message: { type: 'sync:request', stateVector: m.stateVector } };
    case 'awareness:update':
      if (!exactKeys(m, ['type', 'payload'])) return invalid('awareness:update takes exactly type and payload');
      if (!isB64(m.payload)) return invalid('payload must be non-empty base64');
      return { ok: true, message: { type: 'awareness:update', payload: m.payload } };
    default:
      return { ok: false, code: 'UNSUPPORTED_TYPE', message: 'Unknown message type' };
  }
}
