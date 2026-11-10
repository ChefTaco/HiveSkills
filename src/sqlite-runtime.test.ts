import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync as PriorDatabase } from 'node:sqlite';
import { DatabaseSync } from './sqlite.js';
import { initializeSchema as originalSchema } from './migrations/managed-format-1.js';
import { initializeSchema } from './schema.js';
import { backupSqlite } from './release/runtime.js';

test('patched SQLite preserves the released schema and committed WAL data through backup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'skills-sqlite-fixture-'));
  try {
    const file = join(directory, 'registry.sqlite');
    const prior = new PriorDatabase(file);
    originalSchema(prior);
    prior.prepare('INSERT INTO skills VALUES(?,?,?,?,?,?,?)').run('retained', 'Synthetic skill', '', null, 1, 'fixture', 'fixture');
    prior.close();
    const db = new DatabaseSync(file);
    try {
      assert.equal(db.prepare('SELECT sqlite_version() AS version').get().version, '3.54.1');
      initializeSchema(db);
      assert.equal(db.prepare('SELECT name FROM skills WHERE slug=?').get('retained').name, 'Synthetic skill');
      db.exec("BEGIN IMMEDIATE; INSERT INTO skills VALUES('pending','Uncommitted','',NULL,1,'fixture','fixture')");
      const snapshot = join(directory, 'backup.sqlite');
      await backupSqlite(file, snapshot);
      const reader = new DatabaseSync(snapshot, { readOnly: true });
      try {
        assert.equal(reader.prepare('SELECT count(*) AS count FROM skills').get().count, 1);
        assert.equal(reader.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        assert.throws(() => reader.exec('DELETE FROM skills'));
      } finally { reader.close(); }
      assert.equal(statSync(snapshot).mode & 0o777, 0o600);
      await assert.rejects(backupSqlite(file, snapshot));
      db.exec('ROLLBACK');
    } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
