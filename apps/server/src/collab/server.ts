import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer } from 'ws';
import type { AccessEvents } from '../events.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { LiveDocuments } from './documents.js';
import { CollabHub, DEFAULT_HUB_LIMITS, type HubLimits } from './hub.js';
import { isUuid, type SessionRole } from './protocol.js';
import type { TicketStore } from './tickets.js';

export interface CollabOptions {
  prisma: PrismaClient;
  tickets: TicketStore;
  events: AccessEvents;
  /** Exact Origin values browsers may connect from. Requests without Origin rely on the ticket alone. */
  allowedOrigins: string[];
  /** Max size of one incoming frame (ADR-0009 §2). */
  maxPayloadBytes?: number;
  limits?: Partial<HubLimits>;
  /** How long an unused document stays in memory after its last session leaves. */
  unloadDelayMs?: number;
}

export const MAX_WS_PAYLOAD_BYTES = 1024 * 1024;
const PATH_RE = /^\/ws\/documents\/([^/?#]+)$/;

class Reject extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const STATUS_TEXT: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error' };

function rejectUpgrade(socket: Duplex, status: number, code: string): void {
  const body = JSON.stringify({ error: { code, message: STATUS_TEXT[status] ?? 'Error' } });
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n` +
      'Connection: close\r\nContent-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

/**
 * Mounts the realtime endpoint /ws/documents/{id}?ticket=… on the Fastify HTTP server (ADR-0009 §1).
 * The handshake is validated before upgrading so failures are plain HTTP errors.
 */
export function attachCollab(app: FastifyInstance, opts: CollabOptions): { hub: CollabHub; live: LiveDocuments } {
  const live = new LiveDocuments(opts.prisma, opts.unloadDelayMs);
  const hub = new CollabHub(opts.events, live, { ...DEFAULT_HUB_LIMITS, ...opts.limits }, (err, context) =>
    app.log.error({ err }, context),
  );
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayloadBytes ?? MAX_WS_PAYLOAD_BYTES });
  const allowed = new Set(opts.allowedOrigins);

  async function authorize(req: IncomingMessage) {
    // The URL carries a ticket: never log it.
    const url = new URL(req.url ?? '/', 'http://localhost');
    const documentId = PATH_RE.exec(url.pathname)?.[1];
    if (!documentId || !isUuid(documentId)) throw new Reject(404, 'NOT_FOUND');

    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) throw new Reject(403, 'ORIGIN_NOT_ALLOWED');

    const ticket = url.searchParams.get('ticket');
    const claims = ticket ? await opts.tickets.consume(ticket) : null;
    if (!claims || claims.documentId !== documentId) throw new Reject(401, 'INVALID_TICKET');

    // Re-check access: membership may have changed since the ticket was issued.
    const doc = await opts.prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { ownerId: true, engine: true, members: { where: { userId: claims.userId }, select: { role: true } } },
    });
    const user = await opts.prisma.user.findUnique({ where: { id: claims.userId }, select: { displayName: true } });
    if (!doc || !user) throw new Reject(404, 'NOT_FOUND');
    const role: SessionRole | undefined =
      doc.ownerId === claims.userId ? 'owner' : (doc.members[0]?.role as SessionRole | undefined);
    if (role !== 'owner' && role !== 'editor' && role !== 'viewer') throw new Reject(404, 'NOT_FOUND');

    // Load (or reuse) the live document before upgrading, so a load failure is a plain 500.
    await live.acquire(documentId, doc.engine);
    return { documentId, engine: doc.engine, userId: claims.userId, familyId: claims.familyId, displayName: user.displayName, role };
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    authorize(req).then(
      (init) => {
        if (socket.destroyed) {
          live.release(init.documentId);
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws, init));
      },
      (err: unknown) => {
        if (err instanceof Reject) {
          rejectUpgrade(socket, err.status, err.code);
        } else {
          app.log.error({ err }, 'websocket handshake failed');
          rejectUpgrade(socket, 500, 'INTERNAL_ERROR');
        }
      },
    );
  };

  app.server.on('upgrade', onUpgrade);
  // preClose: sockets must be closed before the HTTP server waits for connections to end.
  app.addHook('preClose', async () => {
    app.server.off('upgrade', onUpgrade);
    hub.close();
    wss.close();
  });
  return { hub, live };
}
