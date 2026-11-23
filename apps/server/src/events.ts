import { EventEmitter } from 'node:events';

/**
 * Access changes made through REST that open realtime sessions must react to (ADR-0009 §4, R-13).
 * In-process for now; Phase 6 replaces the transport with Redis Pub/Sub.
 */
export interface AccessEventMap {
  memberRoleChanged: [{ documentId: string; userId: string; role: 'editor' | 'viewer' }];
  memberRemoved: [{ documentId: string; userId: string }];
  documentDeleted: [{ documentId: string }];
  tokenFamilyRevoked: [{ familyId: string }];
}

export class AccessEvents extends EventEmitter<AccessEventMap> {}
