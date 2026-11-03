import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.ts';

export type Db = DatabaseSync;

/**
 * Opens (and migrates) the DB for one send mode. Dry-run and live keep separate files so a
 * dry-run row can never block or count against a live send; the stored mode is checked so a
 * misconfigured DATA_DIR can't mix them either.
 */
export function openDb(file: string, mode: 'dry_run' | 'live'): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);

  const row = db.prepare(`SELECT value FROM kv WHERE key = 'db_mode'`).get() as { value: string } | undefined;
  if (!row) {
    db.prepare(`INSERT INTO kv (key, value, updated_at) VALUES ('db_mode', ?, ?)`).run(mode, Date.now());
  } else if (row.value !== mode) {
    db.close();
    throw new Error(`${file} belongs to mode "${row.value}", not "${mode}" — check DRY_RUN / DATA_DIR`);
  }
  return db;
}

function migrate(db: Db): void {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Runs `fn` in one IMMEDIATE transaction (or inside the caller's, if one is open). */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}
