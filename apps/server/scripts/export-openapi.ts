// Writes docs/openapi.json from the route schemas (ADR-0008 §4). No database needed.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';

const app = buildApp({
  dbCheck: async () => {},
  prisma: {} as never,
  auth: { jwtSecret: 'x'.repeat(32), jwtIssuer: 'i', jwtAudience: 'a', accessTokenTtlSec: 1, refreshTokenTtlSec: 1 },
});
await app.ready();
const out = fileURLToPath(new URL('../../../docs/openapi.json', import.meta.url));
writeFileSync(out, `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
console.log(`wrote ${out}`);
