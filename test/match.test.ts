import { describe, expect, it } from 'vitest';
import { compileTerm, findMatches, normalize, prepareComment } from '../src/core/match.ts';
import { makeTriggers } from './helpers/triggers.ts';

const set = makeTriggers([
  { keyword: 'SKILL', notPhrases: ['skill issue'] },
  { keyword: 'LOOP' },
  { keyword: 'BUILD PLAN' },
  { keyword: 'スキル' },
]);
const kw = (text: string) => findMatches(text, set.triggers).map((t) => t.keyword);

describe('keyword matching — the brief’s rule: case-insensitive, exact word', () => {
  it.each([
    'SKILL',
    'skill',
    'skill please',
    'Skill!!!',
    '🔥SKILL🔥',
    '#skill',
    '@your.account SKILL',
    'the skill.',
    'skill,please',
    'can I get the SKILL? 🙏',
    'ＳＫＩＬＬ', // full-width
    '𝐒𝐊𝐈𝐋𝐋', // mathematical bold
    'SK​ILL', // zero-width space inside
    'skill issue but SKILL please', // one occurrence is outside the notPhrase
  ])('triggers on %j', (text) => {
    expect(kw(text)).toEqual(['SKILL']);
  });

  it.each([
    'unskilled',
    'reskill',
    'skills', // plural only matches when listed as an alias
    'skill-based learning',
    'skill_up',
    '@skill_master nice',
    '@skill.guy look at this',
    'S K I L L',
    'lol skill issue',
    'SKILL ISSUE',
    '',
    '🔥🔥🔥',
  ])('does not trigger on %j', (text) => {
    expect(kw(text)).toEqual([]);
  });

  it('matches aliases as whole words too', () => {
    const withAlias = makeTriggers([{ keyword: 'SKILL', aliases: ['skills', 'skil'] }]);
    const hit = (t: string) => findMatches(t, withAlias.triggers).length > 0;
    expect(hit('skills pls')).toBe(true);
    expect(hit('SKIL')).toBe(true);
    expect(hit('skillset')).toBe(false);
  });

  it('matches multi-word keywords as consecutive words, tolerant of spacing and punctuation', () => {
    expect(kw('build plan pls')).toEqual(['BUILD PLAN']);
    expect(kw('Build   Plan!')).toEqual(['BUILD PLAN']);
    expect(kw('plan build')).toEqual([]);
    expect(kw('build the plan')).toEqual([]);
  });

  it('returns every matching trigger in config order (first wins downstream)', () => {
    expect(kw('LOOP and SKILL')).toEqual(['SKILL', 'LOOP']);
  });

  it('matches CJK keywords as substrings (no word boundaries in CJK)', () => {
    expect(kw('スキルください')).toEqual(['スキル']);
    expect(kw('すきる')).toEqual([]);
  });
});

describe('normalization helpers', () => {
  it('folds width, styled letters and case', () => {
    expect(normalize('ＳＫＩＬＬ')).toBe('skill');
    expect(normalize('𝐒𝐊𝐈𝐋𝐋')).toBe('skill');
  });

  it('removes @mentions before tokenizing', () => {
    expect(prepareComment('@skill.guy hi').tokens).toEqual(['hi']);
  });

  it('compiles CJK terms to substring mode and latin terms to token mode', () => {
    expect(compileTerm('スキル').mode).toBe('substring');
    expect(compileTerm('Build  Plan')).toMatchObject({ mode: 'tokens', text: 'build plan' });
  });
});
