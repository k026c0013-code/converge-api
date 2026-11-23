import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

/**
 * Server-side handling of y-protocols awareness updates (ADR-0010 §5, R-12).
 * Wire format: varUint count, then per entry varUint clientID, varUint clock, varString JSON state.
 */

export interface AwarenessEntry {
  clientId: number;
  clock: number;
  /** Parsed JSON state; null means "this client went away". */
  state: Record<string, unknown> | null;
}

export const MAX_AWARENESS_BYTES = 16 * 1024;

export function decodeAwareness(update: Uint8Array): AwarenessEntry[] {
  const dec = decoding.createDecoder(update);
  const n = decoding.readVarUint(dec);
  if (n > 64) throw new Error('too many awareness entries');
  const out: AwarenessEntry[] = [];
  for (let i = 0; i < n; i++) {
    const clientId = decoding.readVarUint(dec);
    const clock = decoding.readVarUint(dec);
    const parsed: unknown = JSON.parse(decoding.readVarString(dec));
    if (parsed !== null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('awareness state must be an object or null');
    out.push({ clientId, clock, state: parsed as Record<string, unknown> | null });
  }
  if (decoding.hasContent(dec)) throw new Error('trailing bytes in awareness update');
  return out;
}

export function encodeAwareness(entries: AwarenessEntry[]): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, entries.length);
  for (const e of entries) {
    encoding.writeVarUint(enc, e.clientId);
    encoding.writeVarUint(enc, e.clock);
    encoding.writeVarString(enc, JSON.stringify(e.state));
  }
  return encoding.toUint8Array(enc);
}

const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#9a6324', '#800000', '#808000', '#000075'];

/** Stable color per user, so a user's caret looks the same in every tab. */
export function colorFor(userId: string): string {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}

export interface Identity {
  userId: string;
  displayName: string;
}

/**
 * Keeps only entries for `allowedClientId` and overwrites their `user` field with the server's identity.
 * Returns null when nothing remains to forward.
 */
export function sanitizeAwareness(update: Uint8Array, allowedClientId: number, who: Identity): Uint8Array | null {
  const entries = decodeAwareness(update).filter((e) => e.clientId === allowedClientId);
  if (entries.length === 0) return null;
  for (const e of entries) {
    if (e.state) e.state.user = { name: who.displayName, color: colorFor(who.userId), userId: who.userId };
  }
  return encodeAwareness(entries);
}

/** The first clientID found in an update (used to bind a session to one awareness identity). */
export function firstClientId(update: Uint8Array): number | null {
  return decodeAwareness(update)[0]?.clientId ?? null;
}
