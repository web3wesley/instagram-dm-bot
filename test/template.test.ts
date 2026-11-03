import { describe, expect, it } from 'vitest';
import {
  TemplateError,
  maxRenderedBytes,
  parseTemplate,
  pickVariant,
  renderTemplate,
  validateTemplate,
} from '../src/core/template.ts';

const fixed = (v: number) => () => v;

describe('renderTemplate', () => {
  it('substitutes placeholders', () => {
    const out = renderTemplate('Hey {username}, the {keyword} link: {link}', {
      username: 'jess.builds',
      keyword: 'SKILL',
      link: 'https://www.skool.com/x',
    }, fixed(0));
    expect(out).toBe('Hey jess.builds, the SKILL link: https://www.skool.com/x');
  });

  it('falls back to "there" when the username is missing', () => {
    expect(renderTemplate('Hey {username}!', {}, fixed(0))).toBe('Hey there!');
  });

  it('picks spintax options with the supplied rng', () => {
    const tpl = '{Sent|Just sent|Dropped} you a DM';
    expect(renderTemplate(tpl, {}, fixed(0))).toBe('Sent you a DM');
    expect(renderTemplate(tpl, {}, fixed(0.5))).toBe('Just sent you a DM');
    expect(renderTemplate(tpl, {}, fixed(0.999))).toBe('Dropped you a DM');
  });
});

describe('template validation', () => {
  it.each([
    ['{unknown}', /unknown placeholder/],
    ['{a|{b}}', /nested/],
    ['{open', /unclosed/],
    ['close}', /unmatched/],
  ])('rejects %j', (tpl, msg) => {
    expect(() => parseTemplate(tpl)).toThrow(TemplateError);
    expect(validateTemplate(tpl, ['username'])[0]).toMatch(msg);
  });

  it('reports placeholders that are not allowed in a given message', () => {
    expect(validateTemplate('here: {link}', ['username', 'keyword'])).toEqual(['{link} is not allowed here']);
    expect(validateTemplate('Hi {username}', ['username'])).toEqual([]);
  });
});

describe('maxRenderedBytes (Instagram 1000-byte limit)', () => {
  it('uses the longest spintax option and counts UTF-8 bytes', () => {
    expect(maxRenderedBytes('{a|bbb}', {})).toBe(3);
    // Japanese kana are 3 bytes each in UTF-8.
    expect(maxRenderedBytes('あ'.repeat(334), {})).toBe(1002);
    expect(maxRenderedBytes('{username}', { username: 'x'.repeat(30) })).toBe(30);
  });
});

describe('pickVariant', () => {
  it('never repeats one of the last three variants when the pool allows it', () => {
    let rngState = 0;
    const rng = () => (rngState = (rngState * 9301 + 49297) % 233280) / 233280;
    const recent: number[] = [];
    for (let i = 0; i < 50; i++) {
      const v = pickVariant(5, recent, rng);
      expect(recent.slice(-3)).not.toContain(v);
      recent.push(v);
    }
  });

  it('handles tiny pools', () => {
    expect(pickVariant(1, [0], fixed(0.5))).toBe(0);
    expect(pickVariant(2, [0], fixed(0.5))).toBe(1);
    expect(pickVariant(2, [1], fixed(0.5))).toBe(0);
  });
});
