const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]!);

const CSS = `
:root { --bg:#fbfaf7; --fg:#1d1d1b; --muted:#6b6862; --line:#e4e1da; --accent:#c2410c; --card:#fff; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#161513; --fg:#ece9e2; --muted:#a19d95; --line:#2f2d29; --accent:#fb923c; --card:#1e1d1a; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 1.6rem; margin: 0 0 12px; } h2 { font-size: 1.15rem; margin: 28px 0 8px; }
a { color: var(--accent); }
.muted { color: var(--muted); font-size: .92rem; }
.btn { display:inline-block; background:var(--accent); color:#fff; padding:10px 18px; border-radius:8px; text-decoration:none; font-weight:600; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:12px 0; }
table { width:100%; border-collapse: collapse; font-size:.88rem; }
th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align: top; }
.scroll { overflow-x:auto; }
code { font-size:.9em; }
.ok { color:#15803d; } .degraded { color:#b45309; } .down { color:#b91c1c; }
`;

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;
}
