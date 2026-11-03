export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

function parts(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year!, mo: +p.month!, d: +p.day!, h: +p.hour!, mi: +p.minute!, s: +p.second! };
}

/** Offset of `tz` from UTC at instant `ms`, in ms (JST → +9 h). */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - (ms - (ms % 1000));
}

/** Start of the calendar day containing `ms`, in `tz` (used for "DMs sent today" in JST). */
export function dayStart(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return ms - (ms % 1000) - ((p.h * 60 + p.mi) * 60 + p.s) * 1000;
}

/** ISO-8601 with the zone's offset, e.g. 2026-09-28T21:00:00+09:00. Null-safe for optional stamps. */
export function isoInTz(ms: number | null | undefined, tz: string): string | null {
  if (ms === null || ms === undefined) return null;
  const off = tzOffsetMs(ms, tz);
  const local = new Date(ms + off).toISOString().slice(0, 19);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off) / 60_000;
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${local}${sign}${hh}:${mm}`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Uniform random integer in [min, max] milliseconds. */
export const jitter = (rng: () => number, min: number, max: number): number =>
  Math.round(min + rng() * (max - min));
