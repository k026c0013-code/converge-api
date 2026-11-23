import { generateRefreshToken, hashToken } from '../auth/tokens.js';

export interface TicketClaims {
  userId: string;
  documentId: string;
  familyId: string;
}

/** Short-lived, single-use WebSocket connection tickets (ADR-0005). */
export interface TicketStore {
  issue(claims: TicketClaims): Promise<{ ticket: string; expiresIn: number }>;
  /** Returns the claims and deletes the ticket, or null if unknown/expired/used. */
  consume(ticket: string): Promise<TicketClaims | null>;
}

/** In-process store for Phase 2–5. Only SHA-256 hashes are kept. Phase 6 adds a Redis store. */
export class MemoryTicketStore implements TicketStore {
  private readonly tickets = new Map<string, TicketClaims & { expiresAt: number }>();

  constructor(
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  async issue(claims: TicketClaims) {
    this.sweep();
    const ticket = generateRefreshToken(); // 32 random bytes, base64url
    this.tickets.set(hashToken(ticket), { ...claims, expiresAt: this.now() + this.ttlMs });
    return { ticket, expiresIn: Math.floor(this.ttlMs / 1000) };
  }

  async consume(ticket: string) {
    const key = hashToken(ticket);
    const entry = this.tickets.get(key);
    if (!entry) return null;
    this.tickets.delete(key);
    if (entry.expiresAt <= this.now()) return null;
    const { expiresAt: _, ...claims } = entry;
    return claims;
  }

  get size(): number {
    return this.tickets.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, v] of this.tickets) if (v.expiresAt <= now) this.tickets.delete(k);
  }
}
