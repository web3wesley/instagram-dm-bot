/**
 * triggers.json — the keyword → link config. Loaded at boot; a bad file refuses to start
 * (and `test/triggers.test.ts` validates the committed file so a bad config never deploys).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { compileTerm, type CompiledTerm } from '../core/match.ts';
import type { RuleTrigger } from '../core/rules.ts';
import {
  MAX_MESSAGE_BYTES,
  WORST_CASE_USERNAME,
  maxRenderedBytes,
  usesPlaceholder,
  validateTemplate,
} from '../core/template.ts';

const TriggerSchema = z.strictObject({
  keyword: z.string().trim().min(1).max(60),
  aliases: z.array(z.string().trim().min(1)).default([]),
  /** Optional when defaults.link is set (e.g. one Skool link for every reel's keyword). */
  link: z.string().trim().optional(),
  intro: z.string().optional(),
  linkMessage: z.string().optional(),
  /** Falls back to defaults.publicReply (off when neither is set). */
  publicReply: z.boolean().optional(),
  publicReplies: z.array(z.string()).optional(),
  /** Reel/post shortcodes or permalinks; empty = every post. */
  media: z.array(z.string().trim()).default([]),
  notPhrases: z.array(z.string().trim().min(1)).default([]),
  enabled: z.boolean().default(true),
});

const FileSchema = z.strictObject({
  $comment: z.string().optional(),
  defaults: z.strictObject({
    link: z.string().trim().optional(),
    intro: z.string(),
    linkMessage: z.string(),
    /** Public "check your DMs" reply for every trigger that doesn't say otherwise. */
    publicReply: z.boolean().default(false),
    publicReplies: z.array(z.string()).default([]),
  }),
  triggers: z.array(TriggerSchema),
});

export interface Trigger extends RuleTrigger {
  keyword: string;
  aliases: string[];
  link: string;
  intro: string;
  linkMessage: string;
  publicReply: boolean;
  publicReplies: string[];
  mediaShortcodes: string[];
  notPhrases: string[];
  enabled: boolean;
  terms: CompiledTerm[];
  notTerms: CompiledTerm[];
  /** Normalized keyword, used to find the live trigger for a lead later. */
  key: string;
}

export interface TriggerSet {
  triggers: Trigger[];
  hash: string;
  byKey: ReadonlyMap<string, Trigger>;
  /** Used when a lead's trigger was removed after the lead was created. */
  defaults: { intro: string; linkMessage: string; publicReplies: string[] };
}

export class TriggerConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`triggers.json is invalid:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

const HTTPS = /^https:\/\/[^\s]+$/;
const SHORTCODE = /^[A-Za-z0-9_-]{5,}$/;
const PERMALINK = /instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/;
const URLISH = /(https?:\/\/|www\.)/i;

export function mediaToShortcode(entry: string): string | null {
  const m = PERMALINK.exec(entry);
  if (m?.[1]) return m[1];
  return SHORTCODE.test(entry) ? entry : null;
}

/** Normalized key for a keyword, shared with lead records. */
export const triggerKey = (keyword: string): string => compileTerm(keyword).text;

export function parseTriggers(json: unknown): TriggerSet {
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) {
    throw new TriggerConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const { defaults, triggers: raw } = parsed.data;
  const problems: string[] = [];
  const seenTerms = new Map<string, string>();
  const triggers: Trigger[] = [];

  if (defaults.link !== undefined && !HTTPS.test(defaults.link)) problems.push('defaults.link must be an https:// URL');

  raw.forEach((t, idx) => {
    const where = `triggers[${idx}] (${t.keyword})`;
    const intro = t.intro ?? defaults.intro;
    const linkMessage = t.linkMessage ?? defaults.linkMessage;
    const publicReplies = t.publicReplies ?? defaults.publicReplies;
    const publicReply = t.publicReply ?? defaults.publicReply;
    const link = t.link ?? defaults.link ?? '';

    if (!link) problems.push(`${where}: no link — set "link" on the trigger or "link" in defaults`);
    else if (!HTTPS.test(link)) problems.push(`${where}: link must be an https:// URL`);

    const terms = [t.keyword, ...t.aliases].map(compileTerm);
    for (const term of terms) {
      if (!term.text) {
        problems.push(`${where}: "${term.raw}" has no letters or digits to match`);
        continue;
      }
      const prev = seenTerms.get(term.text);
      if (prev) problems.push(`${where}: "${term.raw}" collides with ${prev}`);
      else seenTerms.set(term.text, `${where} "${term.raw}"`);
    }
    const notTerms = t.notPhrases.map(compileTerm);
    for (const n of notTerms) if (!n.text) problems.push(`${where}: notPhrase "${n.raw}" is empty`);

    for (const p of validateTemplate(intro, ['username', 'keyword'])) problems.push(`${where} intro: ${p}`);
    if (usesPlaceholder(intro, 'link')) {
      problems.push(`${where} intro: the link is sent after they reply — remove {link} from the intro`);
    }
    const linkProblems = validateTemplate(linkMessage, ['username', 'keyword', 'link']);
    for (const p of linkProblems) problems.push(`${where} linkMessage: ${p}`);
    if (linkProblems.length === 0 && !usesPlaceholder(linkMessage, 'link')) {
      problems.push(`${where} linkMessage: must contain {link}`);
    }
    for (const [label, tpl, vars] of [
      ['intro', intro, { username: WORST_CASE_USERNAME, keyword: t.keyword }],
      ['linkMessage', linkMessage, { username: WORST_CASE_USERNAME, keyword: t.keyword, link }],
    ] as const) {
      try {
        const bytes = maxRenderedBytes(tpl, vars);
        if (bytes > MAX_MESSAGE_BYTES) {
          problems.push(`${where} ${label}: can render to ${bytes} bytes (Instagram limit ${MAX_MESSAGE_BYTES})`);
        }
      } catch {
        // already reported by validateTemplate
      }
    }

    publicReplies.forEach((r, i) => {
      for (const p of validateTemplate(r, ['username', 'keyword'])) problems.push(`${where} publicReplies[${i}]: ${p}`);
      if (URLISH.test(r)) problems.push(`${where} publicReplies[${i}]: public replies must not contain links`);
    });
    if (publicReply && publicReplies.length < 2) {
      problems.push(`${where}: publicReply needs at least 2 publicReplies variants (identical replies get flagged as spam)`);
    }

    const mediaShortcodes: string[] = [];
    for (const m of t.media) {
      const sc = mediaToShortcode(m);
      if (sc) mediaShortcodes.push(sc);
      else problems.push(`${where}: media "${m}" is not a shortcode or instagram.com/p|reel/<code> URL`);
    }

    triggers.push({
      keyword: t.keyword,
      aliases: t.aliases,
      link,
      intro,
      linkMessage,
      publicReply,
      publicReplies,
      mediaShortcodes,
      notPhrases: t.notPhrases,
      enabled: t.enabled,
      terms,
      notTerms,
      key: triggerKey(t.keyword),
    });
  });

  if (problems.length > 0) throw new TriggerConfigError(problems);
  const hash = createHash('sha256').update(JSON.stringify(json)).digest('hex').slice(0, 12);
  return { triggers, hash, byKey: new Map(triggers.map((t) => [t.key, t])), defaults };
}

export function loadTriggersFile(path: string): TriggerSet {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new TriggerConfigError([`cannot read ${path}: ${(e as Error).message}`]);
  }
  return parseTriggers(json);
}
