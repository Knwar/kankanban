import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

/** Open (creating if needed) and migrate the board database. */
export function openDb(path = ':memory:'): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(db);
  return db;
}

/** Additive migrations for DBs created before a column existed. */
export function migrate(db: DB): void {
  const cols = (db.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name);
  if (!cols.includes('subtasks')) db.exec('ALTER TABLE tasks ADD COLUMN subtasks TEXT');
}
