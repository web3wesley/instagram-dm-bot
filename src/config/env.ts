/**
 * Environment config, validated once at boot. Secrets live only in .env / Railway variables.
 * Missing Meta credentials are allowed (the server still boots so /healthz and tests work);
 * the features that need them report what's missing instead.
 */
import { join } from 'node:path';
import { z } from 'zod';
import { normalizeUsername } from '../core/rules.ts';

const optionalString = z.string().trim().min(1).optional();

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** e.g. https://ig-dm-bot-production.up.railway.app — needed for OAuth and the pages. */
  PUBLIC_BASE_URL: z
    .string()
    .trim()
    .regex(/^https?:\/\/[^\s/]+$/, 'origin only, no trailing slash or path (https://host)')
    .optional(),
  DATA_DIR: z.string().default('./data'),
  TRIGGERS_PATH: z.string().default('./triggers.json'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  REPORT_TZ: z.string().default('Asia/Tokyo'),

  IG_APP_ID: optionalString,
  IG_APP_SECRET: optionalString,
  META_APP_SECRET: optionalString,
  WEBHOOK_VERIFY_TOKEN: optionalString,
  ADMIN_TOKEN: z.string().trim().min(24, 'ADMIN_TOKEN must be at least 24 characters').optional(),
  IG_ACCESS_TOKEN: optionalString,
  EXPECTED_IG_USERNAME: optionalString,
  GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v26.0'),

  DRY_RUN: z.stringbool().default(true),
  ALLOWLIST: z.string().default(''),
  PUBLIC_REPLIES_ENABLED: z.stringbool().default(false),
  DM_HOURLY_CAP: z.coerce.number().int().min(1).max(750).default(190),
  PUBLIC_REPLY_HOURLY_CAP: z.coerce.number().int().min(1).max(200).default(30),
  PRIVATE_REPLY_MAX_AGE_H: z.coerce.number().min(1).max(167).default(166),
  LINK_WINDOW_MARGIN_MIN: z.coerce.number().min(0).max(600).default(30),
  POLL_PROFILE: z.enum(['primary', 'backup', 'off']).default('primary'),
  BACKFILL_SINCE: z
    .string()
    .trim()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO date, e.g. 2026-10-01T00:00:00+09:00')
    .optional(),
  LEAD_RETENTION_DAYS: z.coerce.number().int().min(30).max(3650).default(365),

  NOTION_TOKEN: optionalString,
  NOTION_DATA_SOURCE_ID: optionalString,
  ALERT_WEBHOOK_URL: z.url().optional(),
  PRIVACY_CONTACT: optionalString,
});

export type RawEnv = z.infer<typeof EnvSchema>;

export interface Env extends RawEnv {
  allowlist: ReadonlySet<string>;
  backfillSince: number | undefined;
  dbFile: string;
  mode: 'dry_run' | 'live';
}

export class EnvError extends Error {}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // Treat `KEY=` (as copied from .env.example) the same as unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new EnvError(
      `Invalid environment:\n  - ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  - ')}`,
    );
  }
  const e = parsed.data;
  const mode = e.DRY_RUN ? 'dry_run' : 'live';
  return {
    ...e,
    allowlist: new Set(e.ALLOWLIST.split(',').map(normalizeUsername).filter(Boolean)),
    backfillSince: e.BACKFILL_SINCE ? Date.parse(e.BACKFILL_SINCE) : undefined,
    dbFile: join(e.DATA_DIR, `${mode}.sqlite`),
    mode,
  };
}
