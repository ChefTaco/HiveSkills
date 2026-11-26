import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from './sqlite.js';
import { HTTPException } from 'hono/http-exception';

export type Publication = { schemaVersion: 1; channel: string; skills: Array<Record<string, unknown>> };
export const publicationDigest = (publication: Publication): string => createHash('sha256').update(JSON.stringify(publication)).digest('hex');

/** How long a previewed publication can be approved, and an approved one dispatched. */
const APPROVAL_WINDOW_MS = 300_000;
/** A job in one of these states blocks another operation on its target. */
const ACTIVE = "('queued','running','unknown')";

/** The approval and immutable publication commit before a dispatcher can claim work. */
export class DeploymentJournal {
  constructor(private readonly db: DatabaseSync, private readonly clock = Date.now) {}

  private iso(offsetMs = 0): string {
    return new Date(this.clock() + offsetMs).toISOString();
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Record the exact publication awaiting its actor's approval. */
  preview(target: string, actor: string, manifest: Publication) {
    const id = randomUUID();
    const now = this.iso();
    const expires = this.iso(APPROVAL_WINDOW_MS);
    return this.transaction(() => {
      if (this.db.prepare(`SELECT id FROM deployment_jobs WHERE target=? AND status IN ${ACTIVE}`).get(target)) {
        throw new HTTPException(409, { message: 'Target has an active or unknown deployment; reconcile its original job before another dispatch' });
      }
      this.db.prepare("INSERT INTO deployment_jobs VALUES (?,?,?,'awaiting_approval',NULL,?,?)").run(id, target, actor, now, now);
      this.db.prepare('INSERT INTO deployment_authorizations (job_id,manifest_json,publication_sha256,approval_expires_at) VALUES (?,?,?,?)')
        .run(id, JSON.stringify(manifest), publicationDigest(manifest), expires);
      return this.get(id);
    });
  }

  get(id: string) {
    const row = this.db.prepare('SELECT j.*,a.manifest_json,a.publication_sha256,a.approval_expires_at,a.approved_at,a.magnus_job_id FROM deployment_jobs j JOIN deployment_authorizations a ON a.job_id=j.id WHERE j.id=?').get(id);
    if (!row) throw new HTTPException(404, { message: 'Managed deployment not found' });
    return row;
  }

  /** One-use approval: same actor, same digest, before expiry, and no other active job on the target. */
  approve(id: string, actor: string, digest: string) {
    return this.transaction(() => {
      const row = this.get(id);
      if (row.actor !== actor || row.publication_sha256 !== digest) throw new HTTPException(409, { message: 'Approval owner or exact publication differs' });
      if (row.status !== 'awaiting_approval') throw new HTTPException(409, { message: 'Approval is one-use; inspect the existing job' });
      if (Date.parse(String(row.approval_expires_at)) <= this.clock()) throw new HTTPException(410, { message: 'Approval expired; prepare a fresh preview' });
      const conflict = this.db.prepare(`SELECT id FROM deployment_jobs WHERE target=? AND id<>? AND status IN ${ACTIVE}`).get(row.target!, id);
      if (conflict) throw new HTTPException(409, { message: 'Target already has an active or unknown operation' });
      const now = this.iso();
      this.db.prepare("UPDATE deployment_jobs SET status='queued',updated_at=? WHERE id=?").run(now, id);
      this.db.prepare('UPDATE deployment_authorizations SET approved_at=? WHERE job_id=?').run(now, id);
      return this.get(id);
    });
  }

  /** Fail approvals that expired before dispatch, then claim the oldest approved job. */
  claim() {
    const now = this.iso();
    this.db.prepare("UPDATE deployment_jobs SET status='failed',result='Approval expired before dispatch',updated_at=? WHERE status='queued' AND id IN (SELECT job_id FROM deployment_authorizations WHERE approval_expires_at<=?)")
      .run(now, now);
    return this.db.prepare("UPDATE deployment_jobs SET status='running',updated_at=? WHERE id=(SELECT j.id FROM deployment_jobs j JOIN deployment_authorizations a ON a.job_id=j.id WHERE j.status='queued' AND a.approved_at IS NOT NULL ORDER BY j.created_at LIMIT 1) RETURNING id,target,actor")
      .get(this.iso());
  }

  /** Record a dispatched job's outcome; the first Magnus job id seen is kept. */
  outcome(id: string, status: 'completed' | 'failed' | 'unknown', code: string, magnusJobId: string | null = null) {
    this.transaction(() => {
      this.db.prepare("UPDATE deployment_jobs SET status=?,result=?,updated_at=? WHERE id=? AND status IN ('running','unknown')").run(status, code, this.iso(), id);
      this.db.prepare('UPDATE deployment_authorizations SET magnus_job_id=COALESCE(magnus_job_id,?) WHERE job_id=?').run(magnusJobId, id);
    });
  }

  /** A job left running by a stopped process may have started: mark it for reconciliation, never replay. */
  recover() {
    this.db.prepare("UPDATE deployment_jobs SET status='unknown',result='Interrupted operation; reconcile original Magnus job without replay',updated_at=? WHERE status='running'").run(this.iso());
  }
}
