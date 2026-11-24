// Node-based load client (cross-check for k6): same scenario as collab.k6.js.
// Usage: node loadtest/node-load.mjs [baseUrl[,baseUrl…]=http://127.0.0.1:8080] [users=100] [docs=5] [seconds=30]
// Several comma-separated base URLs spread the users over them round-robin (multi-node without a balancer).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { WebSocket } = require('ws');

const [BASES = 'http://127.0.0.1:8080', USERS = '100', DOCS = '5', SECONDS = '30'] = process.argv.slice(2);
const bases = BASES.split(',');
const BASE = bases[0];
const nUsers = Number(USERS), nDocs = Number(DOCS), seconds = Number(SECONDS), perDoc = nUsers / nDocs;
const payloads = JSON.parse(readFileSync(new URL('./payloads.json', import.meta.url), 'utf8'));
const post = async (path, body, token) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { ...(body && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
};

const run = randomUUID().slice(0, 8);
const users = await Promise.all(
  Array.from({ length: nUsers }, async (_, i) => {
    const email = `node-${run}-${i}@example.test`;
    const r = await post('/api/v1/auth/register', { email, password: 'node-load-test-pw', displayName: `n${i}` });
    return { email, token: r.tokens.accessToken };
  }),
);
const docs = [];
for (let d = 0; d < nDocs; d++) {
  const owner = users[d * perDoc];
  const doc = await post('/api/v1/documents', { title: `node ${run} ${d}` }, owner.token);
  for (let i = d * perDoc + 1; i < (d + 1) * perDoc; i++) await post(`/api/v1/documents/${doc.id}/members`, { email: users[i].email, role: 'editor' }, owner.token);
  docs.push(doc.id);
}

const ack = [], reflect = [];
let errors = 0;
await Promise.all(
  users.map(async (u, i) => {
    const wsBase = bases[i % bases.length].replace(/^http/, 'ws');
    const docId = docs[Math.floor(i / perDoc)];
    const { ticket } = await post(`/api/v1/documents/${docId}/ws-ticket`, undefined, u.token);
    const ws = new WebSocket(`${wsBase}/ws/documents/${docId}?ticket=${ticket}`);
    const sent = new Map();
    await new Promise((resolve) => {
      let timer;
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === 'session:ready') {
          ws.send(JSON.stringify({ type: 'sync:request', stateVector: '' }));
          setTimeout(() => {
            timer = setInterval(() => {
              const now = Date.now();
              const updateId = randomUUID().slice(0, 24) + now.toString(16).padStart(12, '0');
              sent.set(updateId, now);
              ws.send(JSON.stringify({ type: 'update:submit', updateId, payload: payloads[Math.floor(Math.random() * payloads.length)] }));
            }, 1000);
          }, Math.random() * 1000);
          setTimeout(() => ws.close(), seconds * 1000);
        } else if (m.type === 'update:ack') {
          ack.push(Date.now() - sent.get(m.updateId));
        } else if (m.type === 'update:broadcast') {
          const age = Date.now() - parseInt(m.updateId.slice(24), 16);
          if (age >= 0 && age < 60_000) reflect.push(age);
        } else if (m.type === 'error') errors++;
      });
      ws.on('close', () => {
        clearInterval(timer);
        resolve();
      });
      ws.on('error', () => errors++);
    });
  }),
);
const pct = (a, p) => (a.sort((x, y) => x - y), a[Math.min(a.length - 1, Math.floor(a.length * p))] ?? NaN);
console.log(JSON.stringify({ acks: ack.length, ackP50: pct(ack, 0.5), ackP95: pct(ack, 0.95), reflections: reflect.length, reflectP50: pct(reflect, 0.5), reflectP95: pct(reflect, 0.95), errors }));
