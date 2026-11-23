/** Wire format for /ws/documents/{id} (ADR-0009 §2). JSON text frames only. */

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
  | { type: 'update:broadcast'; updateId: string; payload: string; from: { sessionId: string; userId: string } }
  | { type: 'session:role_changed'; role: SessionRole }
  | { type: 'error'; code: string; message: string; ref?: string };

export type ClientMessage = { type: 'update:submit'; updateId: string; payload: string };

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

/** Phase 3 adds these; until then they are recognised but refused (ADR-0009 §2). */
const LATER_TYPES = new Set(['awareness:update', 'sync:request']);

export function parseClientMessage(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'INVALID_MESSAGE', message: 'Message is not valid JSON' };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, code: 'INVALID_MESSAGE', message: 'Message must be a JSON object' };
  }
  const m = data as Record<string, unknown>;
  if (m.type !== 'update:submit') {
    if (typeof m.type === 'string' && LATER_TYPES.has(m.type)) {
      return { ok: false, code: 'UNSUPPORTED_TYPE', message: `${m.type} is not supported yet` };
    }
    return { ok: false, code: 'UNSUPPORTED_TYPE', message: 'Unknown message type' };
  }
  const ref = typeof m.updateId === 'string' && isUuid(m.updateId) ? m.updateId : undefined;
  const keys = Object.keys(m);
  if (keys.length !== 3 || !keys.includes('updateId') || !keys.includes('payload')) {
    return { ok: false, code: 'INVALID_MESSAGE', message: 'update:submit takes exactly type, updateId and payload', ref };
  }
  if (!ref) return { ok: false, code: 'INVALID_MESSAGE', message: 'updateId must be a UUID' };
  if (typeof m.payload !== 'string' || m.payload.length === 0 || !BASE64_RE.test(m.payload)) {
    return { ok: false, code: 'INVALID_MESSAGE', message: 'payload must be non-empty base64', ref };
  }
  return { ok: true, message: { type: 'update:submit', updateId: ref, payload: m.payload } };
}
