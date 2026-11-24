// Generates valid Yjs updates for k6 (which cannot run Yjs). Each appends one paragraph to `content`.
// Usage: node loadtest/gen-payloads.mjs [count]   → loadtest/payloads.json
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const Y = require('yjs');

const count = Number(process.argv[2] ?? 200);
const payloads = [];
for (let i = 0; i < count; i++) {
  const doc = new Y.Doc();
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(`load test line ${i} `.repeat(3))]);
  doc.getXmlFragment('content').insert(0, [p]);
  payloads.push(Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'));
}
writeFileSync(new URL('./payloads.json', import.meta.url), JSON.stringify(payloads));
console.log(`wrote ${count} payloads`);
