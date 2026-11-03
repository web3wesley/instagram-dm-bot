/** Prints the lead funnel per keyword and reel: npm run report */
import { adminFetch } from './lib.ts';

interface Row {
  keyword: string;
  media_id: string;
  permalink: string | null;
  matched: number;
  dm_sent: number;
  replied: number;
  link_sent: number;
  failed: number;
}

const stats = (await (await adminFetch('/admin/stats')).json()) as {
  health: { status: string; reasons: string[]; mode: { dry_run: boolean }; today: Record<string, unknown> };
  funnel_30d: Row[];
  funnel_all: Row[];
};

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const table = (title: string, rows: Row[]) => {
  console.log(`\n${title}`);
  console.table(
    rows.map((r) => ({
      keyword: r.keyword,
      post: r.permalink ?? r.media_id,
      matched: r.matched,
      "DM'd": r.dm_sent,
      replied: r.replied,
      'reply rate': pct(r.replied, r.dm_sent),
      links: r.link_sent,
      failed: r.failed,
    })),
  );
};

const h = stats.health;
console.log(`status: ${h.status}${h.reasons.length ? ` (${h.reasons.join(', ')})` : ''} · ${h.mode.dry_run ? 'DRY RUN' : 'LIVE'}`);
console.log('today:', h.today);
table('Last 30 days', stats.funnel_30d);
table('All time', stats.funnel_all);
