/**
 * Meta Graph API errors and what the worker should do about each.
 *
 * Codes come from Meta's Instagram/Messenger docs; the `already_replied`, `comment_gone` and
 * 2534025 entries come from developer reports and get confirmed against live traffic (see README).
 */

export type ErrorPhase = 'response' | 'connect' | 'timeout' | 'reset';

export class MetaApiError extends Error {
  readonly status: number | undefined;
  readonly code: number | undefined;
  readonly subcode: number | undefined;
  readonly type: string | undefined;
  readonly fbtraceId: string | undefined;
  /** The exact error body Meta returned (logged and stored verbatim). */
  readonly body: unknown;
  readonly phase: ErrorPhase;
  /** Usage headers on the failed response (carries the throttle ETA). */
  usage: Usage | null = null;

  constructor(init: {
    message: string;
    phase: ErrorPhase;
    status?: number | undefined;
    code?: number | undefined;
    subcode?: number | undefined;
    type?: string | undefined;
    fbtraceId?: string | undefined;
    body?: unknown;
  }) {
    super(init.message);
    this.name = 'MetaApiError';
    this.phase = init.phase;
    this.status = init.status;
    this.code = init.code;
    this.subcode = init.subcode;
    this.type = init.type;
    this.fbtraceId = init.fbtraceId;
    this.body = init.body;
  }

  /** Short form for lead reasons: `throttled:80002`, `window_closed:10/2534022`. */
  get tag(): string {
    return this.code === undefined ? this.phase : `${this.code}${this.subcode === undefined ? '' : `/${this.subcode}`}`;
  }

  /** Build from an HTTP error response body (`{error: {message, type, code, error_subcode, fbtrace_id}}`). */
  static fromResponse(status: number, body: unknown): MetaApiError {
    const err = (typeof body === 'object' && body !== null && 'error' in body ? body.error : undefined) as
      | Record<string, unknown>
      | undefined;
    const n = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : undefined);
    return new MetaApiError({
      message: typeof err?.message === 'string' ? err.message : `HTTP ${status}`,
      phase: 'response',
      status,
      code: n(err?.code),
      subcode: n(err?.error_subcode),
      type: typeof err?.type === 'string' ? err.type : undefined,
      fbtraceId: typeof err?.fbtrace_id === 'string' ? err.fbtrace_id : undefined,
      body,
    });
  }

  toJSON(): Record<string, unknown> {
    return {
      message: this.message,
      phase: this.phase,
      status: this.status,
      code: this.code,
      subcode: this.subcode,
      type: this.type,
      fbtrace_id: this.fbtraceId,
      body: this.body,
    };
  }
}

export type ErrorClass =
  | 'auth'
  | 'throttled'
  | 'blocked'
  | 'retryable'
  | 'unknown_outcome'
  | 'window_closed'
  | 'not_approved'
  | 'already_replied'
  | 'comment_gone'
  | 'user_unavailable'
  | 'permanent';

export function classify(e: unknown): ErrorClass {
  if (!(e instanceof MetaApiError)) return 'unknown_outcome';
  if (e.phase === 'connect') return 'retryable';
  if (e.phase === 'timeout' || e.phase === 'reset') return 'unknown_outcome';

  const { code, subcode } = e;
  if (code === 190 || code === 102 || subcode === 463 || subcode === 467) return 'auth';
  if (code === 4 || code === 17 || code === 32 || code === 613 || code === 80002) return 'throttled';
  if (code === 368) return 'blocked';
  if (code === 10 && (subcode === 2018278 || subcode === 2018065 || subcode === 2534022)) return 'window_closed';
  if (code === 10 && subcode === 2018108) return 'user_unavailable';
  if (code === 10900 || (code === 100 && subcode === 2534025)) return 'already_replied';
  if (code === 100 && subcode === 2534001) return 'not_approved';
  if (code === 200 || (code === 10 && subcode === undefined)) return 'not_approved';
  if (code === 100 && subcode === 33) return 'comment_gone';
  if (code === 551 || (code === 100 && (subcode === 2534014 || subcode === 2018001))) return 'user_unavailable';
  if (code === 1 || code === 2) return 'retryable';
  if (code === undefined && (e.status ?? 0) >= 500) return 'unknown_outcome';
  return 'permanent';
}

export interface Usage {
  /** Highest percentage across the reported dimensions (call_count / total_cputime / total_time). */
  maxPct: number;
  callCount: number;
  totalCputime: number;
  totalTime: number;
  /** Minutes until access is regained (Business Use Case header), 0 when not throttled. */
  etaMin: number;
  source: 'buc' | 'app';
}

function readUsage(v: Record<string, unknown>): { cc: number; cpu: number; time: number; eta: number } {
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return {
    cc: n(v.call_count),
    cpu: n(v.total_cputime),
    time: n(v.total_time),
    eta: n(v.estimated_time_to_regain_access),
  };
}

/** Parses X-Business-Use-Case-Usage (preferred) or X-App-Usage. Malformed headers yield null. */
export function parseUsageHeaders(get: (name: string) => string | null): Usage | null {
  const buc = get('x-business-use-case-usage');
  if (buc) {
    try {
      const parsed = JSON.parse(buc) as Record<string, unknown>;
      let best: Usage | null = null;
      for (const list of Object.values(parsed)) {
        for (const item of Array.isArray(list) ? list : []) {
          if (typeof item !== 'object' || item === null) continue;
          const u = readUsage(item as Record<string, unknown>);
          const cand: Usage = {
            maxPct: Math.max(u.cc, u.cpu, u.time),
            callCount: u.cc,
            totalCputime: u.cpu,
            totalTime: u.time,
            etaMin: u.eta,
            source: 'buc',
          };
          if (!best || cand.maxPct > best.maxPct || cand.etaMin > best.etaMin) best = cand;
        }
      }
      if (best) return best;
    } catch {
      // fall through to X-App-Usage
    }
  }
  const app = get('x-app-usage');
  if (app) {
    try {
      const u = readUsage(JSON.parse(app) as Record<string, unknown>);
      return {
        maxPct: Math.max(u.cc, u.cpu, u.time),
        callCount: u.cc,
        totalCputime: u.cpu,
        totalTime: u.time,
        etaMin: 0,
        source: 'app',
      };
    } catch {
      return null;
    }
  }
  return null;
}
