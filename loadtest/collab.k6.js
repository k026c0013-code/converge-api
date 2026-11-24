// k6 load test (requirements §12, CT-09, ADR-0013): 100 connections, 5 documents × 20 editors.
// Measures: REST P95 (target 300 ms), submit→ACK P95 (persisted, target 200 ms) and
// submit→broadcast-received P95 on other connections (edit reflection, target 200 ms).
import http from 'k6/http';
import ws from 'k6/ws';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE = __ENV.BASE_URL || 'http://host.docker.internal:8080';
const WS_BASE = BASE.replace(/^http/, 'ws');
const USERS = Number(__ENV.USERS || 100);
const DOCS = Number(__ENV.DOCS || 5);
const DURATION_S = Number(__ENV.DURATION_S || 30);
const PAYLOADS = JSON.parse(open('./payloads.json'));

const ackLatency = new Trend('collab_ack_ms', true);
const reflectLatency = new Trend('collab_reflect_ms', true);
const broadcasts = new Counter('collab_broadcasts_received');
const errors = new Counter('collab_errors');

export const options = {
  setupTimeout: '300s',
  scenarios: {
    editors: { executor: 'per-vu-iterations', vus: USERS, iterations: 1, maxDuration: `${DURATION_S + 60}s` },
  },
  thresholds: {
    http_req_duration: ['p(95)<300'],
    collab_ack_ms: ['p(95)<200'],
    collab_reflect_ms: ['p(95)<200'],
    collab_errors: ['count==0'],
  },
};

const json = { headers: { 'content-type': 'application/json' } };
const auth = (t) => ({ headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' } });
// No body → no content-type (an empty JSON body is a 400).
const bearerOnly = (t) => ({ headers: { authorization: `Bearer ${t}` } });

export function setup() {
  const run = uuidv4().slice(0, 8);
  const users = [];
  for (let i = 0; i < USERS; i++) {
    const res = http.post(`${BASE}/api/v1/auth/register`, JSON.stringify({ email: `k6-${run}-${i}@example.test`, password: 'k6-load-test-pw', displayName: `k6 ${i}` }), json);
    check(res, { registered: (r) => r.status === 201 });
    users.push({ email: `k6-${run}-${i}@example.test`, token: res.json('tokens.accessToken') });
  }
  const docs = [];
  for (let d = 0; d < DOCS; d++) {
    const owner = users[d * (USERS / DOCS)];
    const doc = http.post(`${BASE}/api/v1/documents`, JSON.stringify({ title: `k6 ${run} #${d}` }), auth(owner.token)).json();
    for (let i = d * (USERS / DOCS) + 1; i < (d + 1) * (USERS / DOCS); i++) {
      const r = http.post(`${BASE}/api/v1/documents/${doc.id}/members`, JSON.stringify({ email: users[i].email, role: 'editor' }), auth(owner.token));
      check(r, { member: (x) => x.status === 201 });
    }
    docs.push(doc.id);
  }
  return { users, docs };
}

export default function (data) {
  const me = data.users[__VU - 1];
  const docId = data.docs[Math.floor((__VU - 1) / (USERS / DOCS))];
  const t = http.post(`${BASE}/api/v1/documents/${docId}/ws-ticket`, null, bearerOnly(me.token));
  if (!check(t, { ticket: (r) => r.status === 201 })) {
    errors.add(1);
    return;
  }
  const sent = {}; // updateId → send time (ms)
  const res = ws.connect(`${WS_BASE}/ws/documents/${docId}?ticket=${t.json('ticket')}`, {}, (socket) => {
    socket.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'session:ready') {
        socket.send(JSON.stringify({ type: 'sync:request', stateVector: '' }));
        // One edit per second per user, spread out so 20 users don't fire in lockstep.
        socket.setTimeout(() => {
          socket.setInterval(() => {
            // The UUID's last group carries the send time (ms, hex) so receivers can measure reflection.
            const now = Date.now();
            const updateId = uuidv4().slice(0, 24) + now.toString(16).padStart(12, '0');
            sent[updateId] = now;
            socket.send(JSON.stringify({ type: 'update:submit', updateId, payload: PAYLOADS[Math.floor(Math.random() * PAYLOADS.length)] }));
          }, 1000);
        }, Math.random() * 1000);
        socket.setTimeout(() => socket.close(), DURATION_S * 1000);
      } else if (m.type === 'update:ack') {
        if (sent[m.updateId]) ackLatency.add(Date.now() - sent[m.updateId]);
        delete sent[m.updateId];
      } else if (m.type === 'update:broadcast') {
        broadcasts.add(1);
        // Only updates sent by this test carry a timestamp; server-made ones (sweeps) are random.
        const age = Date.now() - parseInt(m.updateId.slice(24), 16);
        if (age >= 0 && age < 60_000) reflectLatency.add(age); // all VUs share one clock
      } else if (m.type === 'error') {
        errors.add(1);
      }
    });
  });
  check(res, { 'ws 101': (r) => r && r.status === 101 });
}
