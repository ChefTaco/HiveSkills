import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from './sqlite.js';
import { DeploymentJournal } from './deployment-journal.js';
import { config } from './config.js';
import { compatibleVersion } from './compatibility.js';
import type { HiveEventRecords } from './hive-events.js';
import { EVENT_AUDIT_ACTIONS, EVENT_DEPLOYMENT_STATUSES } from './hive-events.js';
import { TARGET_ACTIONS, type AuditExportRow } from './audit-export.js';
import type { DeploymentTarget, ListedTarget, Release, ReleaseAdvisory, ReleaseSignature, Session, Skill, TargetBinding } from './types.js';
import { keyRevocation, parseRevocationPayload, rawPublicKey, releaseRevocation, verifyReleaseSignature, type RevocationList } from '../scripts/archive-utils.mjs';
import { buildEntry, entryHash, GENESIS_HASH, type LogHead, type LogKind, type LogRow } from '../scripts/transparency-log.mjs';
import { logKey, signEntry, signHead } from './transparency.js';
if (!existsSync(config.databasePath)) throw new Error('Skills database is missing; run hive-skills migrate before opening storage');
const db = new DatabaseSync(config.databasePath, { enableForeignKeyConstraints: true });
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
/** The format of every session id this registry has issued: `randomBytes(32).toString('base64url')`. */
const ISSUED_SESSION_ID = /^[A-Za-z0-9_-]{43}$/;

type SkillRow = { slug: string; name: string; description: string; homepage: string | null; enabled: number; created_at: string; updated_at: string };
type ReleaseRow = { skill_slug: string; version: string; sha256: string; archive_path: string; notes: string | null; min_hermes_version: string | null; max_hermes_version: string | null; created_at: string };
type SessionRow = { id: string; username: string; expires_at: string };
type TargetRow = { name: string; host: string; username: string; enabled: number };
type ListedTargetRow = TargetRow & { magnus_node_id: string | null; agent_refs_json: string | null };
const now = (): string => new Date().toISOString();
type AdvisoryRow = { version: string; level: ReleaseAdvisory['level']; reason: string; created_at: string };
const mapAdvisory = (row: AdvisoryRow): ReleaseAdvisory => ({ level: row.level, reason: row.reason, since: row.created_at });
const mapSkill = (row: SkillRow): Skill => ({ slug: row.slug, name: row.name, description: row.description, homepage: row.homepage, enabled: row.enabled === 1, createdAt: row.created_at, updatedAt: row.updated_at });
const mapRelease = (row: ReleaseRow): Release => ({ skillSlug: row.skill_slug, version: row.version, sha256: row.sha256, archivePath: row.archive_path, notes: row.notes, minHermesVersion: row.min_hermes_version, maxHermesVersion: row.max_hermes_version, createdAt: row.created_at });

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
/** Run `work` in one write transaction; a throw rolls everything back. */
const transaction = <T>(work: () => T): T => {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
};
/**
 * Append one transparency log entry, linked to the previous one and signed with the log key. Callers
 * hold the write transaction that also stores what the entry records, so both land or neither does.
 */
const appendLog = (kind: LogKind, subject: Record<string, unknown>): void => {
  const key = logKey(config.transparencyKeyFile);
  const last = db.prepare('SELECT log_index,hash FROM transparency_log ORDER BY log_index DESC LIMIT 1').get() as { log_index: number; hash: string } | undefined;
  const index = last ? last.log_index + 1 : 0;
  const entry = buildEntry({ index, previousHash: last?.hash ?? GENESIS_HASH, kind, recordedAt: now(), subject });
  const hash = entryHash(entry);
  db.prepare('INSERT INTO transparency_log VALUES (?,?,?,?,?)').run(index, entry, hash, key.keyId, signEntry(key, index, hash));
};
/** The base64url public key of a pinned publisher key id, if pinned. */
const pinnedPublicKey = (keyId: string | null | undefined): string | undefined => {
  const key = keyId ? config.publisherKeys.get(keyId) : undefined;
  return key ? rawPublicKey(key) : undefined;
};
/**
 * Store a signature with the public key that made it (the pinned key it was verified against), so a
 * revocation of that key still applies after the key is unpinned.
 */
const writeSignature = (slug: string, version: string, signature: ReleaseSignature): void => {
  db.prepare('INSERT INTO release_signatures VALUES (?,?,?,?,?) ON CONFLICT(skill_slug,version) DO UPDATE SET key_id=excluded.key_id,signature=excluded.signature,created_at=excluded.created_at').run(slug, version, signature.keyId, signature.value, now());
  const publicKey = pinnedPublicKey(signature.keyId);
  if (publicKey) db.prepare('INSERT INTO release_signature_keys VALUES (?,?,?) ON CONFLICT(skill_slug,version) DO UPDATE SET public_key=excluded.public_key').run(slug, version, publicKey);
  else db.prepare('DELETE FROM release_signature_keys WHERE skill_slug=? AND version=?').run(slug, version);
};
/** The public key that made a stored signature: as recorded, or (for older rows) the pinned key. */
const signerPublicKey = (slug: string, version: string): string | undefined => {
  const row = db.prepare('SELECT s.key_id,k.public_key FROM release_signatures s LEFT JOIN release_signature_keys k ON k.skill_slug=s.skill_slug AND k.version=s.version WHERE s.skill_slug=? AND s.version=?').get(slug, version) as { key_id: string; public_key: string | null } | undefined;
  return row ? row.public_key ?? pinnedPublicKey(row.key_id) : undefined;
};
type RevocationRow = { sequence: number; payload: string; payload_sha256: string; key_id: string; signature: string; actor: string; created_at: string };
/** The stored revocation list with the highest sequence, as served. */
export type StoredRevocations = { sequence: number; payload: string; payloadSha256: string; signature: ReleaseSignature; actor: string; publishedAt: string };
let parsedRevocations: { sequence: number; list: RevocationList } | undefined;
/** A later revocation list arrived while this one was being published. */
export class RevocationSequenceError extends Error {}
/** A release the registry must not store: `status` is the HTTP status to answer with. */
export class ReleaseRefusedError extends Error {
  constructor(message: string, readonly status: 400 | 409) { super(message); }
}
/** The current revocation list, parsed once per sequence. */
const currentRevocations = (): RevocationList | null => {
  const row = db.prepare('SELECT sequence,payload FROM revocation_lists ORDER BY sequence DESC LIMIT 1').get() as { sequence: number; payload: string } | undefined;
  if (!row) return null;
  if (parsedRevocations?.sequence !== row.sequence) parsedRevocations = { sequence: row.sequence, list: parseRevocationPayload(row.payload) };
  return parsedRevocations.list;
};
/** True when the list revokes this signer public key. */
const signedByRevokedKey = (list: RevocationList | null, publicKey: string | null | undefined): boolean =>
  Boolean(list && publicKey && keyRevocation(list, publicKey));
/** Every `release.published` entry ever logged for this exact release (it may have been deleted since). */
const loggedPublication = (slug: string, version: string): boolean =>
  Boolean(db.prepare("SELECT 1 FROM transparency_log WHERE json_extract(entry,'$.kind')='release.published' AND json_extract(entry,'$.subject.slug')=? AND json_extract(entry,'$.subject.version')=? LIMIT 1").get(slug, version));
/**
 * Withdraw from their channels every release the list revokes (by slug and version or by digest) and
 * every release signed by a pinned key it revokes, auditing each as an automatic withdrawal.
 */
const withdrawRevoked = (list: RevocationList | null): Array<{ slug: string; version: string; channel: string }> => {
  if (!list) return [];
  const promoted = db.prepare('SELECT c.channel,c.skill_slug,c.version,r.sha256,s.key_id FROM channel_releases c JOIN releases r ON r.skill_slug=c.skill_slug AND r.version=c.version LEFT JOIN release_signatures s ON s.skill_slug=c.skill_slug AND s.version=c.version ORDER BY c.channel,c.skill_slug').all() as Array<{ channel: string; skill_slug: string; version: string; sha256: string; key_id: string | null }>;
  // Releases whose signer is revoked: by the recorded key, so also after the key was unpinned.
  const withdrawn: Array<{ slug: string; version: string; channel: string }> = [];
  for (const row of promoted) {
    const release = releaseRevocation(list, { slug: row.skill_slug, version: row.version, sha256: row.sha256 });
    const key = !release && signedByRevokedKey(list, signerPublicKey(row.skill_slug, row.version));
    if (!release && !key) continue;
    db.prepare('DELETE FROM channel_releases WHERE channel=? AND skill_slug=?').run(row.channel, row.skill_slug);
    withdrawn.push({ slug: row.skill_slug, version: row.version, channel: row.channel });
    store.audit('system', 'release.withdraw', row.skill_slug, { channel: row.channel, version: row.version, automatic: 'revoked', ...(key ? { revokedKeyId: row.key_id } : {}), sequence: list.sequence });
  }
  return withdrawn;
};

export const deploymentJournal = new DeploymentJournal(db);
export const store = {
  readiness: (): { ready: boolean; missingArchives: number } => {
    db.prepare('SELECT 1').get();
    const missingArchives = [...store.activeManifest('stable'), ...store.activeManifest('canary')].filter(({ release }) => !existsSync(release.archivePath)).length;
    return { ready: missingArchives === 0, missingArchives };
  },
  createDeployment: (target: string, actor: string) => {
    const existing = db.prepare("SELECT id FROM deployment_jobs WHERE target=? AND status IN ('queued','running')").get(target) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID(); db.prepare("INSERT INTO deployment_jobs VALUES (?,?,?,'queued',NULL,?,?)").run(id, target, actor, now(), now()); return id;
  },
  listDeployments: () => db.prepare('SELECT * FROM deployment_jobs ORDER BY created_at DESC LIMIT 100').all(),
  recoverDeployments: () => db.prepare("UPDATE deployment_jobs SET status='unknown',result='Interrupted legacy execution; manual outcome review required',updated_at=? WHERE status='running'").run(now()),
  claimDeployment: (): { id: string; target: string } | undefined => {
    return db.prepare("UPDATE deployment_jobs SET status='running',updated_at=? WHERE id=(SELECT id FROM deployment_jobs WHERE status='queued' AND id NOT IN (SELECT job_id FROM deployment_authorizations) ORDER BY created_at LIMIT 1) RETURNING id,target").get(now()) as { id: string; target: string } | undefined;
  },
  finishDeployment: (id: string, ok: boolean, code: string) => db.prepare('UPDATE deployment_jobs SET status=?,result=?,updated_at=? WHERE id=?').run(ok ? 'completed' : 'failed', code, now(), id),
  listSkills: (): Skill[] => (db.prepare('SELECT * FROM skills WHERE enabled = 1 ORDER BY name').all() as SkillRow[]).map(mapSkill),
  listAllSkills: (): Skill[] => (db.prepare('SELECT * FROM skills ORDER BY name').all() as SkillRow[]).map(mapSkill),
  getSkill: (slug: string): Skill | undefined => { const row = db.prepare('SELECT * FROM skills WHERE slug = ?').get(slug) as SkillRow | undefined; return row && mapSkill(row); },
  createSkill: (skill: Pick<Skill, 'slug' | 'name' | 'description' | 'homepage' | 'enabled'>): Skill => {
    const timestamp = now(); db.prepare('INSERT INTO skills VALUES (?, ?, ?, ?, ?, ?, ?)').run(skill.slug, skill.name, skill.description, skill.homepage, Number(skill.enabled), timestamp, timestamp); return store.getSkill(skill.slug)!;
  },
  updateSkill: (slug: string, patch: { name?: string | undefined; description?: string | undefined; homepage?: string | null | undefined; enabled?: boolean | undefined }): Skill | undefined => {
    const current = store.getSkill(slug); if (!current) return undefined;
    db.prepare('UPDATE skills SET name=?, description=?, homepage=?, enabled=?, updated_at=? WHERE slug=?').run(patch.name ?? current.name, patch.description ?? current.description, patch.homepage === undefined ? current.homepage : patch.homepage, Number(patch.enabled ?? current.enabled), now(), slug); return store.getSkill(slug);
  },
  /** Deleting a skill deletes its releases; the transparency log records which (`skill.deleted`). */
  deleteSkill: (slug: string): boolean => transaction(() => {
    const releases = db.prepare('SELECT version,sha256 FROM releases WHERE skill_slug=? ORDER BY created_at,version').all(slug) as Array<{ version: string; sha256: string }>;
    if (db.prepare('DELETE FROM skills WHERE slug = ?').run(slug).changes !== 1) return false;
    if (releases.length) appendLog('skill.deleted', { slug, releases: releases.map((row) => ({ version: row.version, sha256: row.sha256 })) });
    return true;
  }),
  /** Insert a release and, when given, its verified publisher signature, in one transaction. */
  /** Its transparency log entry (`release.published`) is appended in the same transaction. */
  /**
   * Refused, inside the transaction so a revocation list published meanwhile counts: a version ever
   * logged before (also after its skill was deleted), a revoked release (by version or digest) and a
   * signature by a revoked key.
   */
  addRelease: (release: Release, signature?: ReleaseSignature | null): void => transaction(() => {
    if (loggedPublication(release.skillSlug, release.version)) throw new ReleaseRefusedError('This version was published before and is in the transparency log; releases are immutable, so choose a new version', 409);
    const revocations = currentRevocations();
    if (releaseRevocation(revocations, { slug: release.skillSlug, version: release.version, sha256: release.sha256 })) throw new ReleaseRefusedError('This release version or archive is revoked', 409);
    if (signature && signedByRevokedKey(revocations, pinnedPublicKey(signature.keyId))) throw new ReleaseRefusedError('This publisher key is revoked', 400);
    db.prepare('INSERT INTO releases(skill_slug,version,sha256,archive_path,notes,created_at,min_hermes_version,max_hermes_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(release.skillSlug, release.version, release.sha256, release.archivePath, release.notes, release.createdAt, release.minHermesVersion ?? null, release.maxHermesVersion ?? null);
    if (signature) writeSignature(release.skillSlug, release.version, signature);
    appendLog('release.published', { slug: release.skillSlug, version: release.version, sha256: release.sha256, signature: signature ? { keyId: signature.keyId, value: signature.value } : null });
  }),
  getRelease: (slug: string, version: string): Release | undefined => { const row = db.prepare('SELECT * FROM releases WHERE skill_slug=? AND version=?').get(slug, version) as ReleaseRow | undefined; return row && mapRelease(row); },
  channelRelease: (channel: string, slug: string): Release | undefined => {
    const pin = db.prepare('SELECT version FROM channel_releases WHERE channel=? AND skill_slug=?').get(channel, slug) as { version: string } | undefined;
    return pin && store.getRelease(slug, pin.version);
  },
  activeManifest: (channel = 'stable', allowedSkills?: string[], hermesVersion?: string, enforceCompatibility = false): Array<Skill & { release: Release }> =>
    store.listSkills()
      .filter((skill) => !allowedSkills || allowedSkills.includes(skill.slug))
      .flatMap((skill) => {
        const release = store.channelRelease(channel, skill.slug);
        if (!release) return [];
        if (enforceCompatibility && !compatibleVersion(hermesVersion, release.minHermesVersion, release.maxHermesVersion)) return [];
        return [{ ...skill, release }];
      }),
  /** The channels this exact release is promoted on, in channel order. */
  releaseChannels: (slug: string, version: string): string[] => (db.prepare('SELECT channel FROM channel_releases WHERE skill_slug=? AND version=? ORDER BY channel').all(slug, version) as Array<{ channel: string }>).map((row) => row.channel),
  promoteRelease: (slug: string, version: string, channel: string): void => { db.prepare('INSERT INTO channel_releases VALUES (?,?,?) ON CONFLICT(channel,skill_slug) DO UPDATE SET version=excluded.version').run(channel, slug, version); },
  withdrawRelease: (slug: string, channel: string) => db.prepare('DELETE FROM channel_releases WHERE channel=? AND skill_slug=?').run(channel, slug),
  listChannels: () => db.prepare('SELECT * FROM channel_releases ORDER BY channel,skill_slug').all(),
  listReleases: (slug: string): Array<Release & { advisory: ReleaseAdvisory | null; signature: ReleaseSignature | null }> => {
    const advisories = new Map((db.prepare('SELECT version,level,reason,created_at FROM release_advisories WHERE skill_slug=?').all(slug) as AdvisoryRow[]).map((row) => [row.version, mapAdvisory(row)]));
    const signatures = new Map((db.prepare('SELECT version,key_id,signature FROM release_signatures WHERE skill_slug=?').all(slug) as Array<{ version: string; key_id: string; signature: string }>).map((row) => [row.version, { keyId: row.key_id, value: row.signature }]));
    return (db.prepare('SELECT * FROM releases WHERE skill_slug=? ORDER BY created_at DESC').all(slug) as ReleaseRow[]).map((row) => ({ ...mapRelease(row), advisory: advisories.get(row.version) ?? null, signature: signatures.get(row.version) ?? null }));
  },
  releaseSignature: (slug: string, version: string): ReleaseSignature | null => {
    const row = db.prepare('SELECT key_id,signature FROM release_signatures WHERE skill_slug=? AND version=?').get(slug, version) as { key_id: string; signature: string } | undefined;
    return row ? { keyId: row.key_id, value: row.signature } : null;
  },
  /**
   * Store a verified publisher signature; a new one (for example from a rotated key) replaces the old.
   * The transparency log keeps every signature ever attached (`release.signed`).
   */
  setReleaseSignature: (slug: string, version: string, signature: ReleaseSignature): void => transaction(() => {
    const release = store.getRelease(slug, version);
    if (!release) throw new Error('Release not found');
    if (signedByRevokedKey(currentRevocations(), pinnedPublicKey(signature.keyId))) throw new ReleaseRefusedError('This publisher key is revoked', 400);
    writeSignature(slug, version, signature);
    appendLog('release.signed', { slug, version, sha256: release.sha256, signature: { keyId: signature.keyId, value: signature.value } });
  }),
  /** The current (highest sequence) signed revocation list, as stored, or null before the first. */
  storedRevocations: (): StoredRevocations | null => {
    const row = db.prepare('SELECT * FROM revocation_lists ORDER BY sequence DESC LIMIT 1').get() as RevocationRow | undefined;
    return row ? { sequence: row.sequence, payload: row.payload, payloadSha256: row.payload_sha256, signature: { keyId: row.key_id, value: row.signature }, actor: row.actor, publishedAt: row.created_at } : null;
  },
  /** The current revocation list, parsed (cached per sequence), or null before the first. */
  revocations: (): RevocationList | null => currentRevocations(),
  /** The public key that made a release's stored signature (recorded, or the pinned key), if any. */
  releaseSignerKey: (slug: string, version: string): string | undefined => signerPublicKey(slug, version),
  /** True when the transparency log ever recorded this exact release as published. */
  versionLogged: (slug: string, version: string): boolean => loggedPublication(slug, version),
  /** A stored revocation list by sequence, as served, or null. */
  storedRevocationList: (sequence: number): StoredRevocations | null => {
    const row = db.prepare('SELECT * FROM revocation_lists WHERE sequence=?').get(sequence) as RevocationRow | undefined;
    return row ? { sequence: row.sequence, payload: row.payload, payloadSha256: row.payload_sha256, signature: { keyId: row.key_id, value: row.signature }, actor: row.actor, publishedAt: row.created_at } : null;
  },
  /**
   * Store a verified revocation list whose sequence is above the current one, log it (its digest and
   * signature; the payload is served by sequence) and withdraw every revoked release, and every
   * release signed by a revoked pinned key, from its channels (audited as automatic withdrawals), all
   * in one transaction. Returns the withdrawals.
   */
  publishRevocations: (envelope: { payload: string; signature: ReleaseSignature }, list: RevocationList, actor: string): Array<{ slug: string; version: string; channel: string }> => transaction(() => {
    const current = db.prepare('SELECT MAX(sequence) AS sequence FROM revocation_lists').get() as { sequence: number | null };
    if (current.sequence !== null && list.sequence <= current.sequence) throw new RevocationSequenceError(`Revocation list sequence must be above ${current.sequence}`);
    const payloadSha256 = sha256(envelope.payload);
    db.prepare('INSERT INTO revocation_lists VALUES (?,?,?,?,?,?,?)').run(list.sequence, envelope.payload, payloadSha256, envelope.signature.keyId, envelope.signature.value, actor, now());
    appendLog('revocations.published', { sequence: list.sequence, payloadSha256, signature: { keyId: envelope.signature.keyId, value: envelope.signature.value } });
    const withdrawn = withdrawRevoked(list);
    store.audit(actor, 'revocations.publish', String(list.sequence), { sequence: list.sequence, signatureKeyId: envelope.signature.keyId, keys: list.keys.length, releases: list.releases.length, withdrawn: withdrawn.length });
    return withdrawn;
  }),
  /** The signed head of the transparency log. */
  transparencyHead: (): LogHead => {
    const key = logKey(config.transparencyKeyFile);
    const last = db.prepare('SELECT log_index,hash FROM transparency_log ORDER BY log_index DESC LIMIT 1').get() as { log_index: number; hash: string } | undefined;
    const size = last ? last.log_index + 1 : 0;
    const headHash = last?.hash ?? GENESIS_HASH;
    const signedAt = now();
    return { size, headHash, signedAt, logKey: { keyId: key.keyId, publicKey: key.publicKey }, signature: signHead(key, size, headHash, signedAt) };
  },
  /**
   * Log entries from index `from` on, oldest first: up to `limit` entries and, past the first, no
   * more than `maxBytes` of entry text, so a page stays bounded whatever the entries hold.
   */
  transparencyEntries: (from: number, limit: number, maxBytes = 4 * 1024 * 1024): LogRow[] => {
    const rows: LogRow[] = [];
    let bytes = 0;
    for (const row of db.prepare('SELECT log_index,entry,hash,key_id,signature FROM transparency_log WHERE log_index>=? ORDER BY log_index LIMIT ?').iterate(from, limit) as Iterable<{ log_index: number; entry: string; hash: string; key_id: string; signature: string }>) {
      bytes += row.entry.length;
      if (rows.length && bytes > maxBytes) break;
      rows.push({ index: row.log_index, entry: row.entry, hash: row.hash, keyId: row.key_id, signature: row.signature });
    }
    return rows;
  },
  /**
   * Bring the log and the channels in line with the database, on every start. Whatever was stored
   * without a log entry (before the log existed, or by a restored or older binary) is recorded,
   * marked `backfilled`: releases never logged, signatures that differ from the last logged one, and
   * logged releases that are gone (as `skill.deleted`). A logged release whose digest no longer
   * matches is recorded as deleted and published again. Then revoked releases that are promoted are
   * withdrawn again. Returns the number of entries appended.
   */
  reconcileTransparencyLog: (): { appended: number; withdrawn: number } => transaction(() => {
    type Logged = { sha256: string; signature: string | null };
    const logged = new Map<string, Logged>();
    let before = 0;
    for (const row of db.prepare('SELECT entry FROM transparency_log ORDER BY log_index').iterate() as Iterable<{ entry: string }>) {
      before++;
      const entry = JSON.parse(row.entry) as { kind: string; subject: { slug: string; version?: string; sha256?: string; signature?: { keyId: string; value: string } | null; releases?: Array<{ version: string }> } };
      const id = `${entry.subject.slug}@${entry.subject.version}`;
      if (entry.kind === 'release.published') logged.set(id, { sha256: entry.subject.sha256!, signature: entry.subject.signature ? `${entry.subject.signature.keyId}:${entry.subject.signature.value}` : null });
      else if (entry.kind === 'release.signed') logged.set(id, { ...logged.get(id)!, signature: `${entry.subject.signature!.keyId}:${entry.subject.signature!.value}` });
      else if (entry.kind === 'skill.deleted') for (const release of entry.subject.releases ?? []) logged.delete(`${entry.subject.slug}@${release.version}`);
    }
    const rows = db.prepare('SELECT r.skill_slug,r.version,r.sha256,s.key_id,s.signature FROM releases r LEFT JOIN release_signatures s ON s.skill_slug=r.skill_slug AND s.version=r.version ORDER BY r.created_at,r.skill_slug,r.version').all() as Array<{ skill_slug: string; version: string; sha256: string; key_id: string | null; signature: string | null }>;
    const present = new Set(rows.map((row) => `${row.skill_slug}@${row.version}`));
    const gone = new Map<string, Array<{ version: string; sha256: string }>>();
    const forget = (slug: string, version: string, digest: string) => gone.set(slug, [...(gone.get(slug) ?? []), { version, sha256: digest }]);
    for (const [id, entry] of logged) if (!present.has(id)) { const at = id.lastIndexOf('@'); forget(id.slice(0, at), id.slice(at + 1), entry.sha256); }
    for (const row of rows) { const entry = logged.get(`${row.skill_slug}@${row.version}`); if (entry && entry.sha256 !== row.sha256) forget(row.skill_slug, row.version, entry.sha256); }
    for (const [slug, releases] of gone) appendLog('skill.deleted', { slug, releases, backfilled: true });
    for (const row of rows) {
      const entry = logged.get(`${row.skill_slug}@${row.version}`);
      const signature = row.key_id && row.signature ? { keyId: row.key_id, value: row.signature } : null;
      if (!entry || entry.sha256 !== row.sha256) appendLog('release.published', { slug: row.skill_slug, version: row.version, sha256: row.sha256, signature, backfilled: true });
      else if (signature && entry.signature !== `${signature.keyId}:${signature.value}`) appendLog('release.signed', { slug: row.skill_slug, version: row.version, sha256: row.sha256, signature, backfilled: true });
    }
    // Record the signer of signatures stored before signers were kept, when the pinned key verifies them.
    for (const row of db.prepare('SELECT s.skill_slug,s.version,s.key_id,s.signature,r.sha256 FROM release_signatures s JOIN releases r ON r.skill_slug=s.skill_slug AND r.version=s.version LEFT JOIN release_signature_keys k ON k.skill_slug=s.skill_slug AND k.version=s.version WHERE k.public_key IS NULL').all() as Array<{ skill_slug: string; version: string; key_id: string; signature: string; sha256: string }>) {
      const publicKey = pinnedPublicKey(row.key_id);
      if (publicKey && verifyReleaseSignature(config.publisherKeys, { slug: row.skill_slug, version: row.version, sha256: row.sha256 }, { keyId: row.key_id, value: row.signature })) db.prepare('INSERT INTO release_signature_keys VALUES (?,?,?)').run(row.skill_slug, row.version, publicKey);
    }
    const after = (db.prepare('SELECT COUNT(*) AS count FROM transparency_log').get() as { count: number }).count;
    return { appended: after - before, withdrawn: withdrawRevoked(currentRevocations()).length };
  }),
  /** Every release with its signature and channels, newest first, for the signature overview. */
  signedReleases: (limit: number): Array<{ slug: string; version: string; sha256: string; createdAt: string; signature: ReleaseSignature | null; signerPublicKey: string | undefined; channels: string[] }> => {
    const channels = new Map<string, string[]>();
    for (const row of db.prepare('SELECT channel,skill_slug,version FROM channel_releases ORDER BY channel').all() as Array<{ channel: string; skill_slug: string; version: string }>) {
      const key = `${row.skill_slug}@${row.version}`;
      channels.set(key, [...(channels.get(key) ?? []), row.channel]);
    }
    return (db.prepare('SELECT r.skill_slug,r.version,r.sha256,r.created_at,s.key_id,s.signature FROM releases r LEFT JOIN release_signatures s ON s.skill_slug=r.skill_slug AND s.version=r.version ORDER BY r.created_at DESC,r.skill_slug,r.version LIMIT ?').all(limit) as Array<{ skill_slug: string; version: string; sha256: string; created_at: string; key_id: string | null; signature: string | null }>)
      .map((row) => ({ slug: row.skill_slug, version: row.version, sha256: row.sha256, createdAt: row.created_at, signature: row.key_id && row.signature ? { keyId: row.key_id, value: row.signature } : null, signerPublicKey: row.key_id ? signerPublicKey(row.skill_slug, row.version) : undefined, channels: channels.get(`${row.skill_slug}@${row.version}`) ?? [] }));
  },
  releaseCount: (): number => (db.prepare('SELECT COUNT(*) AS count FROM releases').get() as { count: number }).count,
  releaseAdvisory: (slug: string, version: string): ReleaseAdvisory | null => {
    const row = db.prepare('SELECT version,level,reason,created_at FROM release_advisories WHERE skill_slug=? AND version=?').get(slug, version) as AdvisoryRow | undefined;
    return row ? mapAdvisory(row) : null;
  },
  /** Set or replace the notice on an existing release; the release itself never changes. */
  setReleaseAdvisory: (slug: string, version: string, level: ReleaseAdvisory['level'], reason: string, actor: string): ReleaseAdvisory => {
    db.prepare('INSERT INTO release_advisories VALUES (?,?,?,?,?,?) ON CONFLICT(skill_slug,version) DO UPDATE SET level=excluded.level,reason=excluded.reason,actor=excluded.actor,created_at=excluded.created_at').run(slug, version, level, reason, actor, now());
    return store.releaseAdvisory(slug, version)!;
  },
  clearReleaseAdvisory: (slug: string, version: string): boolean => db.prepare('DELETE FROM release_advisories WHERE skill_slug=? AND version=?').run(slug, version).changes === 1,
  listAudit: (limit: number, before: number) => db.prepare('SELECT id,actor,action,subject,details,created_at FROM audit_log WHERE id<? ORDER BY id DESC LIMIT ?').all(before,limit),
  enrollTarget: (target: string, channel: string, skills: string[] | null): string => {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO target_policies VALUES (?,?,?,?,NULL,?) ON CONFLICT(target) DO UPDATE SET channel=excluded.channel,token_hash=excluded.token_hash,skills_json=excluded.skills_json,updated_at=excluded.updated_at').run(target, channel, tokenHash(token), skills ? JSON.stringify(skills) : null, now());
    return token;
  },
  targetPolicy: (target: string) => {const row=db.prepare('SELECT channel,skills_json FROM target_policies WHERE target=?').get(target) as {channel:string;skills_json:string|null}|undefined;return row?{channel:row.channel,skills:row.skills_json?JSON.parse(row.skills_json) as string[]:undefined}:null;},
  authenticateTarget: (target: string, token: string) => {
    if (!store.getTarget(target)) return null;
    const policy = db.prepare('SELECT channel,skills_json FROM target_policies WHERE target=? AND token_hash=?').get(target, tokenHash(token)) as { channel: string; skills_json: string | null } | undefined;
    return policy ? { channel: policy.channel, skills: policy.skills_json ? JSON.parse(policy.skills_json) as string[] : undefined } : null;
  },
  recordReceipt: (target: string, receipt: unknown) => db.prepare('UPDATE target_policies SET receipt_json=?,updated_at=? WHERE target=?').run(JSON.stringify(receipt), now(), target),
  listReceipts: (targetId?: string) => targetId === undefined
    ? db.prepare('SELECT target,channel,skills_json,receipt_json,updated_at FROM target_policies').all()
    : db.prepare('SELECT target,channel,skills_json,receipt_json,updated_at FROM target_policies WHERE target=?').all(targetId),
  // Sessions are stored by the SHA-256 of their id, so a copy of the database holds no usable session.
  createSession: (session: Session): void => { db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(tokenHash(session.id), session.username, session.expiresAt, now()); },
  /** The session for a cookie's id. Its `id` is the stored key that `deleteSession` takes. */
  getSession: (id: string): Session | undefined => {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
    const key = tokenHash(id);
    let row = db.prepare('SELECT id, username, expires_at FROM sessions WHERE id=?').get(key) as SessionRow | undefined;
    // A session created before ids were hashed is re-keyed on first use, so it stays signed in. Only
    // an id in the issued format (32 random bytes, base64url) can be one, never a stored 64-hex hash.
    if (!row && ISSUED_SESSION_ID.test(id)) {
      row = db.prepare('UPDATE sessions SET id=? WHERE id=? RETURNING id, username, expires_at').get(key, id) as SessionRow | undefined;
    }
    return row && { id: row.id, username: row.username, expiresAt: row.expires_at };
  },
  deleteSession: (key: string): void => { db.prepare('DELETE FROM sessions WHERE id=?').run(key); },
  // Fleet fields appear only on bound targets, so legacy target listings are unchanged.
  listTargets: (nodeId?: string): ListedTarget[] => {
    const select = 'SELECT t.name,t.host,t.username,t.enabled,b.magnus_node_id,b.agent_refs_json FROM deployment_targets t LEFT JOIN target_agent_links b ON b.target=t.name';
    const rows = (nodeId === undefined ? db.prepare(`${select} ORDER BY t.name`).all() : db.prepare(`${select} WHERE b.magnus_node_id=? ORDER BY t.name`).all(nodeId)) as ListedTargetRow[];
    return rows.map((row) => {
      const target: ListedTarget = { name: row.name, host: row.host, username: row.username, enabled: Boolean(row.enabled) };
      if (row.magnus_node_id) target.magnusNodeId = row.magnus_node_id;
      const agentRefs = row.agent_refs_json ? JSON.parse(row.agent_refs_json) as string[] : [];
      if (agentRefs.length) target.agentRefs = agentRefs;
      return target;
    });
  },
  targetBinding: (name: string): TargetBinding | undefined => {
    const row = db.prepare('SELECT magnus_node_id,agent_refs_json FROM target_agent_links WHERE target=?').get(name) as { magnus_node_id: string | null; agent_refs_json: string } | undefined;
    return row?.magnus_node_id ? { magnusNodeId: row.magnus_node_id, agentRefs: JSON.parse(row.agent_refs_json) as string[] } : undefined;
  },
  /** An undefined binding keeps the stored fleet binding; null clears it. */
  saveTarget: (target: DeploymentTarget, binding?: TargetBinding | null): void => {
    const prior = db.prepare('SELECT * FROM deployment_targets WHERE name=?').get(target.name) as TargetRow | undefined;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (prior && (prior.host !== target.host || prior.username !== target.username || !target.enabled)) db.prepare('DELETE FROM target_policies WHERE target=?').run(target.name);
      db.prepare('INSERT INTO deployment_targets VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET host=excluded.host,username=excluded.username,enabled=excluded.enabled').run(target.name, target.host, target.username, Number(target.enabled));
      if (binding === null) db.prepare('DELETE FROM target_agent_links WHERE target=?').run(target.name);
      else if (binding) db.prepare('INSERT INTO target_agent_links VALUES (?,?,?,?) ON CONFLICT(target) DO UPDATE SET magnus_node_id=excluded.magnus_node_id,agent_refs_json=excluded.agent_refs_json,updated_at=excluded.updated_at').run(target.name, binding.magnusNodeId, JSON.stringify(binding.agentRefs), now());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  },
  seedTarget: (target: DeploymentTarget): void => { db.prepare('INSERT OR IGNORE INTO deployment_targets VALUES (?, ?, ?, ?)').run(target.name, target.host, target.username, Number(target.enabled)); },
  getTarget: (name: string): DeploymentTarget | undefined => { const row = db.prepare('SELECT * FROM deployment_targets WHERE name=? AND enabled=1').get(name) as TargetRow | undefined; return row && { name: row.name, host: row.host, username: row.username, enabled: row.enabled === 1 }; },
  /** Records HiveEvents derive from, at or after `since`. Receipts are few, so all latest receipts are read. */
  hiveEventRecords: (since: string): HiveEventRecords => {
    type Linked = { magnus_node_id: string | null; agent_refs_json: string | null };
    const link = (row: Linked) => ({ magnusNodeId: row.magnus_node_id, agentRefs: row.agent_refs_json ? JSON.parse(row.agent_refs_json) as string[] : [] });
    const marks = (values: readonly string[]) => values.map(() => '?').join(',');
    const deployments = db.prepare(`SELECT j.id,j.target,j.status,j.result,j.updated_at,b.magnus_node_id,b.agent_refs_json FROM deployment_jobs j LEFT JOIN target_agent_links b ON b.target=j.target WHERE j.status IN (${marks(EVENT_DEPLOYMENT_STATUSES)}) AND j.updated_at>=?`)
      .all(...EVENT_DEPLOYMENT_STATUSES, since) as Array<Linked & { id: string; target: string; status: string; result: string | null; updated_at: string }>;
    const audit = db.prepare(`SELECT id,action,subject,details,created_at FROM audit_log WHERE action IN (${marks(EVENT_AUDIT_ACTIONS)}) AND created_at>=?`)
      .all(...EVENT_AUDIT_ACTIONS, since) as Array<{ id: number; action: string; subject: string; details: string; created_at: string }>;
    const receipts = db.prepare('SELECT p.target,p.receipt_json,p.updated_at,b.magnus_node_id,b.agent_refs_json FROM target_policies p LEFT JOIN target_agent_links b ON b.target=p.target WHERE p.receipt_json IS NOT NULL')
      .all() as Array<Linked & { target: string; receipt_json: string | null; updated_at: string }>;
    return {
      deployments: deployments.map((row) => ({ id: row.id, target: row.target, status: row.status, result: row.result, updatedAt: row.updated_at, ...link(row) })),
      audit: audit.map((row) => ({ id: row.id, action: row.action, subject: row.subject, details: row.details, createdAt: row.created_at })),
      receipts: receipts.map((row) => ({ target: row.target, receiptJson: row.receipt_json, updatedAt: row.updated_at, ...link(row) })),
    };
  },
  /** Audit rows after `afterId`, oldest first, each with the current fleet link of a target it names. */
  auditExportRows: (afterId: number, count: number): AuditExportRow[] => {
    const marks = TARGET_ACTIONS.map(() => '?').join(',');
    const rows = db.prepare(`SELECT a.id,a.actor,a.action,a.subject,a.details,a.created_at,b.magnus_node_id,b.agent_refs_json FROM audit_log a LEFT JOIN target_agent_links b ON b.target=a.subject AND a.action IN (${marks}) WHERE a.id>? ORDER BY a.id LIMIT ?`)
      .all(...TARGET_ACTIONS, afterId, count) as Array<{ id: number; actor: string; action: string; subject: string; details: string; created_at: string; magnus_node_id: string | null; agent_refs_json: string | null }>;
    return rows.map((row) => ({ id: row.id, actor: row.actor, action: row.action, subject: row.subject, details: row.details, createdAt: row.created_at, magnusNodeId: row.magnus_node_id, agentRefs: row.agent_refs_json ? JSON.parse(row.agent_refs_json) as string[] : [] }));
  },
  audit: (actor: string, action: string, subject: string, details: Record<string, unknown>): void => { db.prepare('INSERT INTO audit_log (actor, action, subject, details, created_at) VALUES (?, ?, ?, ?, ?)').run(actor, action, subject, JSON.stringify(details), now()); }
};
