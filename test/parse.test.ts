import { describe, expect, it } from 'vitest';
import { parseWebhook, type CommentEvent, type InboundEvent } from '../src/webhook/parse.ts';
import { JESS, ME, REEL, T0, fixture } from './helpers/fixtures.ts';

const NOW = T0 + 60_000;
const parse = (name: string) => parseWebhook(fixture(name), NOW);

describe('comment payloads', () => {
  it('parses the real `changes[]` shape', () => {
    expect(parse('webhook/comment.changes.json')).toEqual([
      {
        t: 'comment',
        accountId: ME.userId,
        commentId: '17865799348089039',
        mediaId: REEL.id,
        adId: undefined,
        parentId: undefined,
        fromId: JESS.id,
        username: JESS.username,
        text: 'SKILL please 🙏',
        at: T0,
        atExact: false,
        productType: 'REELS',
      } satisfies CommentEvent,
    ]);
  });

  it('parses the docs’ flat `entry.field/value` shape wrapped in an array', () => {
    const [ev] = parse('webhook/comment.flat.json');
    expect(ev).toMatchObject({ t: 'comment', commentId: '17865799348089040', text: '𝐒𝐊𝐈𝐋𝐋', username: 'sam_codes' });
  });

  it('parses the Facebook-Login shape and keys ad comments to the original media', () => {
    const [ev] = parse('webhook/comment.fbshape.ad.json');
    expect(ev).toMatchObject({
      t: 'comment',
      commentId: '17865799348089041',
      mediaId: REEL.id,
      adId: '120200000000000001',
    });
  });

  it('keeps parent_id on threaded replies', () => {
    const [ev] = parse('webhook/comment.reply.json');
    expect(ev).toMatchObject({ t: 'comment', parentId: '17865799348089039', at: 1790597100_000 });
  });

  it('treats a string ISO timestamp on the value as exact', () => {
    const body = fixture<{ entry: [{ changes: [{ value: Record<string, unknown> }] }] }>('webhook/comment.changes.json');
    body.entry[0].changes[0].value.timestamp = '2026-09-28T11:59:00+0000';
    const [ev] = parseWebhook(body, NOW) as CommentEvent[];
    expect(ev).toMatchObject({ at: Date.parse('2026-09-28T11:59:00Z'), atExact: true });
  });
});

describe('messaging payloads', () => {
  it('parses a text reply', () => {
    expect(parse('webhook/message.text.json')).toEqual([
      expect.objectContaining<Partial<InboundEvent>>({
        t: 'inbound',
        senderId: JESS.id,
        recipientId: ME.userId,
        kind: 'text',
        text: 'yes please!',
        at: 1790596920_000,
      }),
    ]);
  });

  it('parses quick replies and postbacks as replies with a payload', () => {
    expect(parse('webhook/message.quick_reply.json')[0]).toMatchObject({ kind: 'quick_reply', payload: 'SEND_LINK' });
    expect(parse('webhook/postback.json')[0]).toMatchObject({ kind: 'postback', payload: 'SEND_LINK', text: 'Send me the link' });
  });

  it('ignores echoes of our own sends, deletions, reads, reactions and standby events', () => {
    expect(parse('webhook/message.echo.json')).toEqual([{ t: 'ignored', reason: 'echo', accountId: ME.userId }]);
    expect(parse('webhook/message.deleted.json')).toEqual([{ t: 'ignored', reason: 'deleted', accountId: ME.userId }]);
    expect(parse('webhook/read_reaction.json').map((e) => e.t === 'ignored' && e.reason)).toEqual(['read', 'reaction']);
    expect(parse('webhook/standby.json')).toEqual([{ t: 'ignored', reason: 'standby', accountId: ME.userId }]);
  });
});

describe('batches and junk', () => {
  it('flattens a mixed batch in order and skips live comments and other fields', () => {
    const events = parse('webhook/batch.mixed.json');
    expect(events.map((e) => (e.t === 'ignored' ? `ignored:${e.reason}` : e.t))).toEqual([
      'comment',
      'comment',
      'ignored:live_comment',
      'ignored:unsupported_field',
      'inbound',
    ]);
  });

  it.each([
    [null, 'malformed'],
    [{ object: 'page', entry: [] }, 'wrong_object'],
    [{ object: 'instagram' }, 'malformed'],
  ])('rejects %j', (body, reason) => {
    expect(parseWebhook(body, NOW)).toEqual([{ t: 'ignored', reason }]);
  });

  it('drops comment changes without ids', () => {
    const body = { object: 'instagram', entry: [{ id: ME.userId, changes: [{ field: 'comments', value: { text: 'SKILL' } }] }] };
    expect(parseWebhook(body, NOW)).toEqual([{ t: 'ignored', reason: 'malformed', accountId: ME.userId }]);
  });
});
