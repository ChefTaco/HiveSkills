import { DatabaseSync } from 'node:sqlite';
/**
 * Signed revocation lists and the append-only transparency log. Both are new tables: release rows,
 * their positional writes and older binaries are unaffected. Triggers refuse every UPDATE and DELETE
 * of a stored list or log entry, so history can only grow.
 */
export function initializeRevocationsAndTransparencyLog(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS revocation_lists (
    sequence INTEGER PRIMARY KEY CHECK(sequence > 0),
    payload TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
    key_id TEXT NOT NULL, signature TEXT NOT NULL,
    actor TEXT NOT NULL, created_at TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS revocation_lists_no_update BEFORE UPDATE ON revocation_lists
    BEGIN SELECT RAISE(ABORT, 'revocation lists are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS revocation_lists_no_delete BEFORE DELETE ON revocation_lists
    BEGIN SELECT RAISE(ABORT, 'revocation lists are append-only'); END;
  CREATE TABLE IF NOT EXISTS transparency_log (
    log_index INTEGER PRIMARY KEY CHECK(log_index >= 0),
    entry TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
    key_id TEXT NOT NULL, signature TEXT NOT NULL
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS transparency_log_no_update BEFORE UPDATE ON transparency_log
    BEGIN SELECT RAISE(ABORT, 'the transparency log is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS transparency_log_no_delete BEFORE DELETE ON transparency_log
    BEGIN SELECT RAISE(ABORT, 'the transparency log is append-only'); END;`);
}
