import { DatabaseSync } from 'node:sqlite';
/** Additive authorization/outcome journal; legacy jobs remain unchanged. */
export function initializeDeploymentJournal(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS deployment_authorizations (
    job_id TEXT PRIMARY KEY REFERENCES deployment_jobs(id), manifest_json TEXT NOT NULL,
    publication_sha256 TEXT NOT NULL, approval_expires_at TEXT NOT NULL,
    approved_at TEXT, magnus_job_id TEXT, executor TEXT NOT NULL DEFAULT 'magnus'
  ) STRICT;`);
}
