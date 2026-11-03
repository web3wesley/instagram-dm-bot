/**
 * Message templates: {username}, {keyword} and {link} placeholders plus spintax {a|b|c}.
 * Groups cannot nest and there is no escaping — a literal brace is a validation error.
 */

export const PLACEHOLDERS = ['username', 'keyword', 'link'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
export type TemplateVars = Partial<Record<Placeholder, string>>;

/** Instagram DM text limit (UTF-8 bytes). */
export const MAX_MESSAGE_BYTES = 1000;
/** Instagram usernames are at most 30 characters — used for worst-case length checks. */
export const WORST_CASE_USERNAME = 'x'.repeat(30);
/** Fallback when a comment arrives without a username. */
export const USERNAME_FALLBACK = 'there';

type Part =
  | { t: 'text'; v: string }
  | { t: 'var'; name: Placeholder }
  | { t: 'spin'; options: string[] };

export class TemplateError extends Error {}

const isPlaceholder = (s: string): s is Placeholder => (PLACEHOLDERS as readonly string[]).includes(s);

export function parseTemplate(tpl: string): Part[] {
  const parts: Part[] = [];
  let i = 0;
  while (i < tpl.length) {
    const open = tpl.indexOf('{', i);
    const close = tpl.indexOf('}', i);
    if (close !== -1 && (open === -1 || close < open)) {
      throw new TemplateError(`unmatched "}" at position ${close}`);
    }
    if (open === -1) {
      parts.push({ t: 'text', v: tpl.slice(i) });
      break;
    }
    if (open > i) parts.push({ t: 'text', v: tpl.slice(i, open) });
    const end = tpl.indexOf('}', open + 1);
    if (end === -1) throw new TemplateError(`unclosed "{" at position ${open}`);
    const nested = tpl.indexOf('{', open + 1);
    if (nested !== -1 && nested < end) throw new TemplateError(`nested "{" at position ${nested}`);
    const inner = tpl.slice(open + 1, end);
    if (inner.includes('|')) {
      parts.push({ t: 'spin', options: inner.split('|') });
    } else {
      const name = inner.trim();
      if (!isPlaceholder(name)) throw new TemplateError(`unknown placeholder {${inner}}`);
      parts.push({ t: 'var', name });
    }
    i = end + 1;
  }
  return parts;
}

/** Returns human-readable problems (empty when the template is valid). */
export function validateTemplate(tpl: string, allowed: readonly Placeholder[]): string[] {
  let parts: Part[];
  try {
    parts = parseTemplate(tpl);
  } catch (e) {
    return [(e as Error).message];
  }
  const problems: string[] = [];
  for (const p of parts) {
    if (p.t === 'var' && !allowed.includes(p.name)) problems.push(`{${p.name}} is not allowed here`);
  }
  if (!tpl.trim()) problems.push('template is empty');
  return problems;
}

export function usesPlaceholder(tpl: string, name: Placeholder): boolean {
  try {
    return parseTemplate(tpl).some((p) => p.t === 'var' && p.name === name);
  } catch {
    return false;
  }
}

function varValue(name: Placeholder, vars: TemplateVars): string {
  if (name === 'username') return vars.username || USERNAME_FALLBACK;
  return vars[name] ?? '';
}

export function renderTemplate(tpl: string, vars: TemplateVars, rng: () => number): string {
  return parseTemplate(tpl)
    .map((p) => {
      if (p.t === 'text') return p.v;
      if (p.t === 'var') return varValue(p.name, vars);
      return p.options[Math.min(p.options.length - 1, Math.floor(rng() * p.options.length))] ?? '';
    })
    .join('');
}

export const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Worst case over every spintax choice (the longest option of each group). */
export function maxRenderedBytes(tpl: string, vars: TemplateVars): number {
  return parseTemplate(tpl).reduce((sum, p) => {
    if (p.t === 'text') return sum + byteLength(p.v);
    if (p.t === 'var') return sum + byteLength(varValue(p.name, vars));
    return sum + Math.max(...p.options.map(byteLength));
  }, 0);
}

/**
 * Picks a variant index at random, avoiding the most recently used ones so consecutive
 * public replies never repeat (as far as the pool allows).
 */
export function pickVariant(count: number, recent: readonly number[], rng: () => number, avoid = 3): number {
  if (count <= 1) return 0;
  const window = new Set(recent.slice(-Math.min(avoid, count - 1)));
  const pool = Array.from({ length: count }, (_, i) => i).filter((i) => !window.has(i));
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))] ?? 0;
}
