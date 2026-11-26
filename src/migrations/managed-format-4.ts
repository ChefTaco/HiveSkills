import { DatabaseSync } from 'node:sqlite';
/**
 * Advisory deprecation and yank notices on immutable releases. Kept in a side table so release rows,
 * their positional writes and older binaries are unaffected; a notice goes with its release.
 */
export function initializeReleaseAdvisories(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS release_advisories (
    skill_slug TEXT NOT NULL, version TEXT NOT NULL,
    level TEXT NOT NULL CHECK(level IN ('deprecated','yanked')), reason TEXT NOT NULL,
    actor TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(skill_slug, version),
    FOREIGN KEY(skill_slug, version) REFERENCES releases(skill_slug, version) ON DELETE CASCADE
  ) STRICT;`);
}
