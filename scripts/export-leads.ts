/** Downloads the lead log as CSV from the running bot: npm run leads:export [-- out.csv] */
import { writeFileSync } from 'node:fs';
import { adminFetch } from './lib.ts';

const out = process.argv[2] ?? `ig-leads-${new Date().toISOString().slice(0, 10)}.csv`;
const res = await adminFetch('/admin/leads.csv');
writeFileSync(out, Buffer.from(await res.arrayBuffer()));
console.log(`wrote ${out}`);
