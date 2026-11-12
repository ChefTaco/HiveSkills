// Suite audit export: HiveAuditRecord v1 pages over the registry audit log; Apache-2.0.
import { decodeCursor, encodeCursor, feedPage, type Page } from '@hivemagnus/hive-common/events';
import { redact } from '@hivemagnus/hive-common/log';
import { HiveAuditRecord } from './browser-contracts.js';
import type { z } from 'zod';

export type HiveAuditRecordValue = z.infer<typeof HiveAuditRecord>;
/** Service tokens need this permission; registry administrators are accepted as well. */
export const AUDIT_READ_PERMISSION = 'hiveskills:audit:read';
export const AUDIT_EXPORT_PATH = '/v1/audit/export';
export const AUDIT_EXPORT_DEFAULT_LIMIT = 100;
export const AUDIT_EXPORT_MAX_LIMIT = 200;
const PRODUCT = 'hiveskills';
const MAX_DETAILS_BYTES = 4096;

/** One stored audit row, with the current fleet link of the target it names (if any). */
export type AuditExportRow = {
  id: number; actor: string; action: string; subject: string; details: string; createdAt: string;
  magnusNodeId: string | null; agentRefs: string[];
};

/** Stored action names mapped to suite action names, with the kind of record they act on. */
const ACTIONS: Record<string, { action: string; target: string; withId: boolean }> = {
  login: { action: 'session.login', target: 'session', withId: false },
  // The stored logout subject is the revoked session id: never exported.
  logout: { action: 'session.logout', target: 'session', withId: false },
  seed: { action: 'release.seed', target: 'release', withId: true },
  'skill.create': { action: 'skill.create', target: 'skill', withId: true },
  'skill.update': { action: 'skill.update', target: 'skill', withId: true },
  'skill.delete': { action: 'skill.delete', target: 'skill', withId: true },
  'release.create': { action: 'release.create', target: 'release', withId: true },
  'release.promote': { action: 'release.promote', target: 'skill', withId: true },
  'release.withdraw': { action: 'release.withdraw', target: 'skill', withId: true },
  'target.update': { action: 'target.update', target: 'target', withId: true },
  'target.enroll': { action: 'target.enroll', target: 'target', withId: true },
  'deployment.prepared': { action: 'deployment.prepare', target: 'target', withId: true },
  'deployment.queued': { action: 'deployment.queue', target: 'target', withId: true },
  'deployment.approved': { action: 'deployment.approve', target: 'target', withId: true },
  'deployment.reconciled': { action: 'deployment.reconcile', target: 'target', withId: true },
};
/** Audited subjects that are deployment targets, so their fleet link applies. */
export const TARGET_ACTIONS = Object.entries(ACTIONS).filter(([, value]) => value.target === 'target').map(([key]) => key);

/** Cursor for the last exported row: an opaque encoding of its integer id. */
export const encodeAuditCursor = (id: number): string => encodeCursor({ i: id });

/** The id after which a page starts; null for a cursor this endpoint did not issue. */
export function decodeAuditCursor(cursor: string): number | null {
  let value: Record<string, string | number>;
  try { value = decodeCursor(cursor); } catch { return null; }
  const id = value['i'];
  return Object.keys(value).length === 1 && typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id : null;
}

const iso = (value: string): string | null => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

/** Flat, redacted scalar details, trimmed to the 4 KB limit by dropping trailing keys. */
function exportDetails(raw: string): Record<string, string | number | boolean> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const clean = redact(parsed as Record<string, unknown>);
  const details: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(clean)) {
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) details[key] = value;
  }
  const encoder = new TextEncoder();
  while (encoder.encode(JSON.stringify(details)).length > MAX_DETAILS_BYTES) {
    const keys = Object.keys(details);
    delete details[keys[keys.length - 1]!];
  }
  return details;
}

/** Suite action name for a stored one; unknown actions keep a sanitized `audit.<name>` form. */
function suiteAction(stored: string): { action: string; target: string | null; withId: boolean } {
  const known = ACTIONS[stored];
  if (known) return known;
  const name = stored.toLowerCase().replace(/[^a-z0-9_.]+/g, '_').replace(/^\.+|\.+$/g, '').replace(/\.{2,}/g, '.') || 'unknown';
  return { action: name.includes('.') ? name : `audit.${name}`, target: null, withId: false };
}

/** Fleet subject from the target's link; one agent reference only when the target names exactly one. */
function fleetSubject(row: AuditExportRow, details: Record<string, string | number | boolean>, stored: string): HiveAuditRecordValue['subject'] {
  // A target update records the node it linked at the time; prefer that over the current link.
  const recorded = stored === 'target.update' && typeof details['magnusNodeId'] === 'string' ? details['magnusNodeId'] : null;
  const nodeId = recorded ?? row.magnusNodeId;
  if (!nodeId) return undefined;
  const agentRef = row.magnusNodeId === nodeId && row.agentRefs.length === 1 ? row.agentRefs[0] : undefined;
  return { nodeId, ...(agentRef ? { agentRef } : {}) };
}

/** Map one stored row to a HiveAuditRecord; null when it cannot form a valid record. */
export function auditRecord(row: AuditExportRow): HiveAuditRecordValue | null {
  const occurredAt = iso(row.createdAt);
  if (!occurredAt) return null;
  const mapped = suiteAction(row.action);
  const details = exportDetails(row.details);
  const isTarget = mapped.target === 'target';
  const subject = isTarget ? fleetSubject(row, details, row.action) : undefined;
  const target = mapped.target ? { type: mapped.target, ...(mapped.withId && row.subject ? { id: row.subject } : {}) } : undefined;
  const actorId = row.actor || 'unknown';
  const candidate = {
    id: `${PRODUCT}:audit:${row.id}`,
    product: PRODUCT,
    occurredAt,
    action: mapped.action,
    outcome: 'success' as const,
    actor: { type: actorId === 'system' ? 'system' as const : 'user' as const, id: actorId },
    ...(target ? { target } : {}),
    ...(subject ? { subject } : {}),
    details,
  };
  const checked = HiveAuditRecord.safeParse(candidate);
  return checked.success ? checked.data : null;
}

/**
 * One export page, oldest first by id. `rows` holds up to `limit + 1` rows after the cursor;
 * the cursor always advances past rows read, so a row that cannot be mapped is skipped and counted.
 */
export function auditExportPage(rows: readonly AuditExportRow[], limit: number, onDropped: (count: number) => void = () => {}): Page<HiveAuditRecordValue> {
  const page = feedPage(rows, limit, (row) => encodeAuditCursor(row.id));
  const data: HiveAuditRecordValue[] = [];
  for (const row of page.data) {
    const record = auditRecord(row);
    if (record) data.push(record);
  }
  if (data.length !== page.data.length) onDropped(page.data.length - data.length);
  return { data, nextCursor: page.nextCursor };
}
