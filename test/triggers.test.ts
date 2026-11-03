import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TriggerConfigError, loadTriggersFile, mediaToShortcode, parseTriggers } from '../src/config/triggers.ts';
import { DEFAULTS, makeTriggers } from './helpers/triggers.ts';

const repoFile = (name: string) => fileURLToPath(new URL(`../${name}`, import.meta.url));

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof TriggerConfigError) return e.problems;
    throw e;
  }
  return [];
}

describe('committed trigger files', () => {
  it('triggers.example.json is valid', () => {
    expect(loadTriggersFile(repoFile('triggers.example.json')).triggers.length).toBeGreaterThan(0);
  });

  it.runIf(existsSync(repoFile('triggers.json')))('triggers.json (the deployed config) is valid', () => {
    expect(() => loadTriggersFile(repoFile('triggers.json'))).not.toThrow();
  });
});

describe('trigger validation', () => {
  it('fills defaults and normalizes media permalinks to shortcodes', () => {
    const t = makeTriggers([{ keyword: 'LOOP', media: ['https://www.instagram.com/reel/DAbCdEfGh12/?igsh=abc', 'Cabc123XYZ'] }])
      .triggers[0]!;
    expect(t.intro).toBe(DEFAULTS.intro);
    expect(t.mediaShortcodes).toEqual(['DAbCdEfGh12', 'Cabc123XYZ']);
    expect(mediaToShortcode('https://instagram.com/p/Cx1_-y2/')).toBe('Cx1_-y2');
    expect(mediaToShortcode('not a reel')).toBeNull();
  });

  it('rejects keyword and alias collisions, case- and width-insensitively', () => {
    const p = problems(() => makeTriggers([{ keyword: 'SKILL' }, { keyword: 'LOOP', aliases: ['ｓｋｉｌｌ'] }]));
    expect(p.join()).toMatch(/collides/);
  });

  it('requires https links', () => {
    expect(problems(() => makeTriggers([{ keyword: 'SKILL', link: 'http://example.com' }])).join()).toMatch(/https/);
  });

  it('uses defaults.link for triggers without their own link (one Skool link, a new keyword per reel)', () => {
    const skool = 'https://www.skool.com/your-community/about';
    const set = parseTriggers({
      defaults: { ...DEFAULTS, link: skool },
      triggers: [{ keyword: 'SKILL' }, { keyword: 'LOOP', link: 'https://example.com/loop' }],
    });
    expect(set.triggers.map((t) => t.link)).toEqual([skool, 'https://example.com/loop']);
  });

  it('inherits the public-reply switch from defaults unless a trigger overrides it', () => {
    const set = parseTriggers({
      defaults: { ...DEFAULTS, link: 'https://example.com/x', publicReply: true },
      triggers: [{ keyword: 'SKILL' }, { keyword: 'LOOP', publicReply: false }],
    });
    expect(set.triggers.map((t) => t.publicReply)).toEqual([true, false]);
    expect(makeTriggers([{ keyword: 'SKILL' }]).triggers[0]?.publicReply).toBe(false); // off unless asked for
  });

  it('requires a link on the trigger or in defaults', () => {
    const p = problems(() => parseTriggers({ defaults: DEFAULTS, triggers: [{ keyword: 'SKILL' }] }));
    expect(p.join()).toMatch(/no link/);
    const bad = problems(() => parseTriggers({ defaults: { ...DEFAULTS, link: 'http://x.com' }, triggers: [{ keyword: 'SKILL' }] }));
    expect(bad.join()).toMatch(/defaults\.link must be an https/);
  });

  it('keeps the link out of the intro and requires it in the link message', () => {
    expect(problems(() => makeTriggers([{ keyword: 'SKILL', intro: 'here: {link}' }])).join()).toMatch(/remove \{link\}/);
    expect(problems(() => makeTriggers([{ keyword: 'SKILL', linkMessage: 'no link here' }])).join()).toMatch(/must contain \{link\}/);
  });

  it('rejects intros that could exceed 1000 bytes with a 30-character username', () => {
    // "Hey " + 30-char username + " " + 320 kana × 3 bytes = 995 bytes → fits; 330 kana = 1025 → rejected.
    const intro = (kana: number) => `Hey {username} ${'あ'.repeat(kana)}`;
    expect(problems(() => makeTriggers([{ keyword: 'SKILL', intro: intro(320) }]))).toEqual([]);
    expect(problems(() => makeTriggers([{ keyword: 'SKILL', intro: intro(330) }])).join()).toMatch(/1025 bytes/);
  });

  it('rejects links in public replies and single-variant public replies', () => {
    expect(problems(() => makeTriggers([{ keyword: 'SKILL', publicReplies: ['see https://x.com', 'b'] }])).join()).toMatch(/must not contain links/);
    expect(problems(() => makeTriggers([{ keyword: 'SKILL', publicReply: true, publicReplies: ['only one'] }])).join()).toMatch(/at least 2/);
  });

  it('rejects unknown keys (catches typos like "notphrases")', () => {
    const p = problems(() => parseTriggers({ defaults: DEFAULTS, triggers: [{ keyword: 'SKILL', link: 'https://a.b', notphrases: [] }] }));
    expect(p.join()).toMatch(/notphrases|Unrecognized/i);
  });

  it('rejects unknown placeholders', () => {
    expect(problems(() => makeTriggers([{ keyword: 'SKILL', intro: 'Hey {name}' }])).join()).toMatch(/unknown placeholder/);
  });

  it('gives each trigger a stable normalized key and hashes the config', () => {
    const a = makeTriggers([{ keyword: 'Build  Plan' }]);
    expect(a.byKey.get('build plan')?.keyword).toBe('Build  Plan');
    expect(a.hash).toMatch(/^[0-9a-f]{12}$/);
  });
});
