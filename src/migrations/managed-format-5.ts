import { DatabaseSync } from 'node:sqlite';
/**
 * Publisher signatures (Ed25519) of immutable releases. Kept in a side table so release rows, their
 * positional writes and older binaries are unaffected; a signature goes with its release.
 */
export function initializeReleaseSignatures(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS release_signatures (
    skill_slug TEXT NOT NULL, version TEXT NOT NULL,
    key_id TEXT NOT NULL, signature TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(skill_slug, version),
    FOREIGN KEY(skill_slug, version) REFERENCES releases(skill_slug, version) ON DELETE CASCADE
  ) STRICT;`);
}
