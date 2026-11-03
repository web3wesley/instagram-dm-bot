import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** Raw bytes exactly as they sit on disk (signature tests need the untouched body). */
export function fixtureRaw(name: string): Buffer {
  return readFileSync(`${root}${name}`);
}

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(fixtureRaw(name).toString('utf8')) as T;
}

/** Our test account (the IG professional account id on every fixture entry). */
export const ME = { userId: '17841400000000001', username: 'your.account', appScopedId: '9000000000000001' };
/** The commenter in comment.changes.json / message.text.json. */
export const JESS = { id: '2031528510825908', username: 'jess.builds' };
export const REEL = { id: '17900000000000099', shortcode: 'DAbCdEfGh12' };
/** entry.time of comment.changes.json, in ms. */
export const T0 = 1790596800_000;
