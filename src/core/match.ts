/**
 * Keyword matching for comment triggers.
 *
 * - Case-insensitive, whole-word: "SKILL" and "skill please" match, "unskilled" does not.
 * - NFKC + zero-width stripping, so styled text (𝐒𝐊𝐈𝐋𝐋, ＳＫＩＬＬ) and invisible characters still match.
 * - @mentions are removed first, so tagging "@skill.guy" never triggers.
 * - Tokens keep internal - _ . ' characters, so "skill-based" is not "skill".
 * - Multi-word keywords match as consecutive tokens; CJK keywords match as substrings
 *   (CJK text has no spaces to split words on).
 * - notPhrases ("skill issue") suppress any keyword occurrence they overlap.
 */

const ZERO_WIDTH = /[​-‍⁠﻿︀-️]/g;
const MENTION = /@[\p{L}\p{N}._]+/gu;
const TOKEN = /[\p{L}\p{N}]+(?:['’._-][\p{L}\p{N}]+)*/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WHITESPACE = /\s+/g;

export function normalize(s: string): string {
  return s.normalize('NFKC').replace(ZERO_WIDTH, '').toLowerCase();
}

export interface CompiledTerm {
  raw: string;
  mode: 'tokens' | 'substring';
  tokens: string[];
  /** Canonical form: tokens joined by one space (token mode) or whitespace-free text (substring mode). */
  text: string;
}

export function compileTerm(term: string): CompiledTerm {
  const norm = normalize(term).trim();
  if (CJK.test(norm)) {
    return { raw: term, mode: 'substring', tokens: [], text: norm.replace(WHITESPACE, '') };
  }
  const tokens = norm.match(TOKEN) ?? [];
  return { raw: term, mode: 'tokens', tokens, text: tokens.join(' ') };
}

export interface PreparedComment {
  tokens: string[];
  /** Normalized, mention-free, whitespace-free text for substring (CJK) terms. */
  compact: string;
}

export function prepareComment(text: string): PreparedComment {
  const n = normalize(text).replace(MENTION, ' ');
  return { tokens: n.match(TOKEN) ?? [], compact: n.replace(WHITESPACE, '') };
}

type Span = readonly [start: number, end: number];

function tokenOccurrences(hay: readonly string[], needle: readonly string[]): Span[] {
  const out: Span[] = [];
  if (needle.length === 0 || needle.length > hay.length) return out;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) out.push([i, i + needle.length]);
  }
  return out;
}

function substringOccurrences(hay: string, needle: string): Span[] {
  const out: Span[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    out.push([i, i + needle.length]);
  }
  return out;
}

function occurrences(c: PreparedComment, term: CompiledTerm): Span[] {
  return term.mode === 'tokens'
    ? tokenOccurrences(c.tokens, term.tokens)
    : substringOccurrences(c.compact, term.text);
}

const overlaps = (a: Span, b: Span): boolean => a[0] < b[1] && b[0] < a[1];

export interface MatchableTrigger {
  /** The keyword plus its aliases, compiled. */
  terms: readonly CompiledTerm[];
  notTerms: readonly CompiledTerm[];
}

/** True when some keyword/alias occurrence is not covered by one of the trigger's notPhrases. */
export function triggerMatches(c: PreparedComment, t: MatchableTrigger): boolean {
  for (const term of t.terms) {
    const blockers = t.notTerms.filter((n) => n.mode === term.mode).flatMap((n) => occurrences(c, n));
    for (const occ of occurrences(c, term)) {
      if (!blockers.some((b) => overlaps(occ, b))) return true;
    }
  }
  return false;
}

/** All triggers whose keyword appears in `text`, in config order (first one wins downstream). */
export function findMatches<T extends MatchableTrigger>(text: string, triggers: readonly T[]): T[] {
  const c = prepareComment(text);
  return triggers.filter((t) => triggerMatches(c, t));
}
