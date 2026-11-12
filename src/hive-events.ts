import { decodeCursor, encodeCursor, feedPage, validateHiveEvent, type HiveEvent, type HiveEventSeverity, type Page } from '@hivemagnus/hive-common/events';

/** Events older than this are not served. */
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** Every HiveSkills record lives on the single HiveXUI skills screen (`linkTo('hiveskills', 'skills')`). */
export const SKILLS_LINK_PATH = '/?page=skills';
const PRODUCT = 'hiveskills';

export type FleetLink = { magnusNodeId: string | null; agentRefs: string[] };
export type DeploymentRecord = { id: string; target: string; status: string; result: string | null; updatedAt: string } & FleetLink;
export type AuditRecord = { id: number; action: string; subject: string; details: string; createdAt: string };
export type ReceiptRecord = { target: string; receiptJson: string | null; updatedAt: string } & FleetLink;
/** Stored records an event can be derived from, at or after `since`. */
export type HiveEventRecords = { deployments: DeploymentRecord[]; audit: AuditRecord[]; receipts: ReceiptRecord[] };
export type FeedPosition = { occurredAt: string; id: string };

/** Only terminal or attention-needing deployment states become events. */
export const EVENT_DEPLOYMENT_STATUSES = ['completed', 'failed', 'unknown'] as const;
/** Audit actions that become events: release publication, channel promotion and withdrawal, skill deletion. */
export const EVENT_AUDIT_ACTIONS = ['release.create', 'release.promote', 'release.withdraw', 'skill.delete'] as const;
const EXPIRED_APPROVAL = 'Approval expired before dispatch';
const NODE_ID = /^[a-z0-9_-]{2,32}$/;
const AGENT_REF = /^[a-z0-9_-]{2,32}~[a-z0-9_-]{2,32}$/;

const iso = (value: string): string | null => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

/** Fleet subject from the target's link; one agent reference only when the target names exactly one. */
const subjectOf = (link: FleetLink): HiveEvent['subject'] => {
  if (!link.magnusNodeId || !NODE_ID.test(link.magnusNodeId)) return undefined;
  const agentRef = link.agentRefs.length === 1 && AGENT_REF.test(link.agentRefs[0]!) ? link.agentRefs[0] : undefined;
  return { nodeId: link.magnusNodeId, ...(agentRef ? { agentRef } : {}) };
};

const event = (fields: { id: string; type: string; severity: HiveEventSeverity; title: string; summary: string; occurredAt: string; subject?: HiveEvent['subject']; sourceRef: string }): HiveEvent => ({
  id: fields.id,
  product: PRODUCT,
  type: fields.type,
  severity: fields.severity,
  title: fields.title,
  summary: fields.summary,
  occurredAt: fields.occurredAt,
  ...(fields.subject ? { subject: fields.subject } : {}),
  link: { product: PRODUCT, path: SKILLS_LINK_PATH },
  sourceRef: fields.sourceRef,
});

// Job results can hold executor replies, so summaries never include them.
const deploymentEvent = (job: DeploymentRecord): HiveEvent | null => {
  const occurredAt = iso(job.updatedAt);
  if (!occurredAt) return null;
  const base = { id: `${PRODUCT}:deployment:${job.id}:${job.status}`, occurredAt, subject: subjectOf(job), sourceRef: job.id };
  if (job.status === 'completed') return event({ ...base, type: 'deployment.succeeded', severity: 'info', title: `Skills deployed to ${job.target}`, summary: `The skill deployment to target ${job.target} completed.` });
  if (job.status === 'failed' && job.result === EXPIRED_APPROVAL) return event({ ...base, type: 'deployment.expired', severity: 'info', title: `Skill deployment to ${job.target} expired`, summary: `The approval for the deployment to target ${job.target} expired before dispatch. Prepare a fresh preview to deploy.` });
  if (job.status === 'failed') return event({ ...base, type: 'deployment.failed', severity: 'critical', title: `Skill deployment to ${job.target} failed`, summary: `The skill deployment to target ${job.target} failed. Review the deployment job in HiveSkills.` });
  if (job.status === 'unknown') return event({ ...base, type: 'deployment.unknown', severity: 'warning', title: `Skill deployment to ${job.target} needs reconciling`, summary: `The outcome of the deployment to target ${job.target} is unknown. Reconcile the original job before another deployment.` });
  return null;
};

const auditEvent = (entry: AuditRecord): HiveEvent | null => {
  const occurredAt = iso(entry.createdAt);
  if (!occurredAt) return null;
  let details: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(entry.details);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) details = parsed as Record<string, unknown>;
  } catch { /* An unreadable detail only shortens the summary. */ }
  const channel = typeof details['channel'] === 'string' ? details['channel'] : null;
  const version = typeof details['version'] === 'string' ? details['version'] : null;
  const base = { id: `${PRODUCT}:audit:${entry.id}:${entry.action}`, occurredAt, sourceRef: `audit:${entry.id}` };
  switch (entry.action) {
    case 'release.create': {
      const at = entry.subject.lastIndexOf('@');
      const skill = at > 0 ? entry.subject.slice(0, at) : entry.subject, released = at > 0 ? entry.subject.slice(at + 1) : null;
      return event({ ...base, type: 'skill.release.published', severity: 'info', title: `Skill ${skill}${released ? ` ${released}` : ''} published`, summary: `An immutable release of skill ${skill} was stored. It reaches agents only after promotion to a channel.` });
    }
    case 'release.promote':
      return event({ ...base, type: 'skill.release.promoted', severity: 'info', title: `Skill ${entry.subject}${version ? ` ${version}` : ''} promoted${channel ? ` to ${channel}` : ''}`, summary: `Enrolled targets${channel ? ` on the ${channel} channel` : ''} receive this release of skill ${entry.subject} on their next sync.` });
    case 'release.withdraw':
      return event({ ...base, type: 'skill.release.withdrawn', severity: 'warning', title: `Skill ${entry.subject} withdrawn${channel ? ` from ${channel}` : ''}`, summary: `Skill ${entry.subject} no longer has a release${channel ? ` on the ${channel} channel` : ''}, so targets stop receiving it.` });
    case 'skill.delete':
      return event({ ...base, type: 'skill.deleted', severity: 'warning', title: `Skill ${entry.subject} deleted`, summary: `Skill ${entry.subject} and its releases were removed from the registry.` });
    default:
      return null;
  }
};

/** The latest agent receipt is the only one stored; a failed restart stays an event while it is the latest. */
const receiptEvent = (receipt: ReceiptRecord): HiveEvent | null => {
  if (!receipt.receiptJson) return null;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(receipt.receiptJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    body = parsed as Record<string, unknown>;
  } catch { return null; }
  if (body['status'] !== 'restart_failed') return null;
  const occurredAt = iso(typeof body['receivedAt'] === 'string' ? body['receivedAt'] : receipt.updatedAt);
  if (!occurredAt) return null;
  return event({
    id: `${PRODUCT}:receipt:${receipt.target}:${Date.parse(occurredAt)}:restart_failed`,
    type: 'target.restart.failed',
    severity: 'warning',
    title: `Agent restart failed on ${receipt.target}`,
    summary: `Target ${receipt.target} installed its skills but reported that the agent failed to restart.`,
    occurredAt,
    subject: subjectOf(receipt),
    sourceRef: receipt.target,
  });
};

const after = (left: FeedPosition, right: FeedPosition): boolean =>
  left.occurredAt > right.occurredAt || (left.occurredAt === right.occurredAt && left.id > right.id);

/** Read a cursor from `encodePosition`; null for anything else. */
export function decodePosition(cursor: string): FeedPosition | null {
  let value: Record<string, string | number>;
  try { value = decodeCursor(cursor); } catch { return null; }
  const occurredAt = typeof value['t'] === 'string' ? iso(value['t']) : null;
  if (!occurredAt || occurredAt !== value['t'] || typeof value['i'] !== 'string' || value['i'] === '') return null;
  return { occurredAt, id: value['i'] };
}

export const encodePosition = (event: FeedPosition): string => encodeCursor({ t: event.occurredAt, i: event.id });

/** The earliest record time a page can need: the retention start or the cursor, whichever is later. */
export function feedSince(position: FeedPosition | undefined, now: number): string {
  const retention = new Date(now - RETENTION_MS).toISOString();
  return position && position.occurredAt > retention ? position.occurredAt : retention;
}

/**
 * One feed page, oldest first by (occurredAt, id). Every event is validated strictly; an
 * invalid one is dropped and counted, never served.
 */
export function hiveEventPage(records: HiveEventRecords, position: FeedPosition | undefined, limit: number, now: number, onDropped: (count: number) => void = () => {}): Page<HiveEvent> {
  const retention = new Date(now - RETENTION_MS).toISOString();
  const candidates = [...records.deployments.map(deploymentEvent), ...records.audit.map(auditEvent), ...records.receipts.map(receiptEvent)];
  const events: HiveEvent[] = [];
  let dropped = 0;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const checked = validateHiveEvent(candidate, { strict: true });
    if (!checked.ok) { dropped++; continue; }
    const value = checked.value;
    if (value.occurredAt < retention || (position && !after(value, position))) continue;
    events.push(value);
  }
  if (dropped) onDropped(dropped);
  events.sort((left, right) => (after(left, right) ? 1 : after(right, left) ? -1 : 0));
  return feedPage(events.slice(0, limit + 1), limit, encodePosition);
}
