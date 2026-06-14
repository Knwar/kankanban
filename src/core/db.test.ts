import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { migrate, openDb } from './db.js';

describe('openDb', () => {
  it('opens an in-memory db with the schema applied', () => {
    const db = openDb();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[]).map((r) => r.name);
    assert.ok(tables.includes('projects'));
    assert.ok(tables.includes('tasks'));
    assert.ok(tables.includes('task_events'));
    db.close();
  });

  it('creates the parent directory for a file-backed db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kankan-db-'));
    const path = join(dir, 'nested', 'board.db'); // parent does not exist yet
    const db = openDb(path);
    assert.ok(existsSync(path));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('migrate', () => {
  it('adds the subtasks column to a legacy tasks table', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE tasks (id TEXT)');
    migrate(db);
    const cols = (db.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes('subtasks'));
    db.close();
  });

  it('is a no-op when subtasks already exists', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE tasks (id TEXT, subtasks TEXT)');
    assert.doesNotThrow(() => migrate(db));
    db.close();
  });
});
