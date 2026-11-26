import { parseAccountLinks, linkedLocalId } from './account-links.js';
import { configuredOathweaveVerifier } from './identity.js';
import { OathweaveError } from '@hivemagnus/hive-common/oathweave';
import { AUDIT_EXPORT_DEFAULT_LIMIT, AUDIT_EXPORT_MAX_LIMIT, AUDIT_READ_PERMISSION, auditExportPage, decodeAuditCursor } from './audit-export.js';
import { createHealth } from '@hivemagnus/hive-common/health';
import { requestContext, securityHeaders } from '@hivemagnus/hive-common/hono';
import { parseFeedQuery } from '@hivemagnus/hive-common/events';
import { decodePosition, feedSince, hiveEventPage, type FeedPosition } from './hive-events.js';
import { maintenanceActive } from './release/runtime.js';
import { metadata } from './release/runtime.js';
import { packageRoot as releasePackageRoot } from './paths.js';
import { SERVICE_CAPABILITIES } from './capabilities.js';
import { home as upgradeHome, updateStatus } from './release/runtime.js';
import { bodyLimit } from 'hono/body-limit';
import { existsSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Context, MiddlewareHandler } from 'hono';
import { config } from './config.js';
import { persistArchive, assertSkillId, removeArchive } from './archive.js';
import { authenticateOsUser, createSession, readAuth, removeSession, sessionCookie, validUsername } from './auth.js';
import { store, deploymentJournal } from './db.js';
import { requireMagnusExecutor, executeMagnusJob, magnusExecutorConfiguration } from './magnus-deployment.js';
import { type Publication } from './deployment-journal.js';
import { z } from 'zod';
import { hiveXuiStubResponse } from './hivexui-stub.js';
import type { AuthContext, Release, TargetBinding } from './types.js';
import { compareVersions, parseVersion } from './compatibility.js';
import { archiveDigest } from './archive-digest.js';
import { LoginThrottle, clientAddress } from './login-throttle.js';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Release as BrowserRelease, PinnedRelease, CreateSkill, UpdateSkill, UploadRelease, UploadArchiveQuery, UpdateTarget, PromoteRelease, EnrollTarget, TargetQuery, ReceiptQuery } from './browser-contracts.js';

type Variables = { auth: AuthContext };
type JsonObject = Record<string, unknown>;

const app = new Hono<{ Variables: Variables }>();
const verifyIdentity = configuredOathweaveVerifier();
const accountLinks=parseAccountLinks(process.env.HIVESKILLS_OATHWEAVE_IDENTITIES_JSON??'[]');
const loginThrottle = new LoginThrottle();
const channels = ['stable', 'canary'] as const;

const asObject = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};

const text = (value: unknown, field: string, max = 10_000): string => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new HTTPException(400, { message: `${field} is invalid` });
  }
  return value.trim();
};

const optionalText = (value: unknown, field: string, max = 10_000): string | null =>
  value === undefined || value === null || value === '' ? null : text(value, field, max);

const slug = (value: unknown): string => {
  const result = text(value, 'slug', 63).toLowerCase();
  try {
    assertSkillId(result);
  } catch (error) {
    throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Invalid slug' });
  }
  return result;
};

const channelParam = (value: string | undefined): string => {
  const channel = value ?? 'stable';
  if (!(channels as readonly string[]).includes(channel)) throw new HTTPException(400, { message: 'Invalid channel' });
  return channel;
};

const bearer = (header: string | undefined): string => (header ?? '').replace(/^Bearer /, '');

const requireAuth = (admin = false): MiddlewareHandler<{ Variables: Variables }> => async (c, next): Promise<void> => {
  const authorization=c.req.header('authorization');
  if (authorization) {
    if (!verifyIdentity || !authorization.startsWith('Bearer ')) throw new HTTPException(401,{message:'Invalid identity token'});
    let identity;
    try { identity=await verifyIdentity(authorization.slice(7)); } catch { throw new HTTPException(401,{message:'Invalid or revoked identity session'}); }
    const permission=c.req.method==='GET'?'hiveskills:read':c.req.path.startsWith('/admin/deployments')?'hiveskills:deploy':'hiveskills:write';
    if (!identity.permissions.includes(permission) && !identity.permissions.includes('hiveskills:admin')) throw new HTTPException(403,{message:'Permission required'});
    let username:string;
    try {username=linkedLocalId(accountLinks,identity);} catch {throw new HTTPException(403,{message:'An explicit registry account link is required'});}
    const isAdmin=config.adminUsers.has(username);
    if(admin && !isAdmin)throw new HTTPException(403,{message:'Local administrator access is required'});
    if(c.req.method!=='GET' && c.req.path.startsWith('/admin/deployments')){if(!magnusExecutorConfiguration()){c.res=c.json({error:'DEPLOYMENT_ADAPTER_UNAVAILABLE',message:'Skill execution requires the Magnus job adapter'},503);return;}if(c.req.path.endsWith('/approve')&&(identity.authTime===undefined||Date.now()-identity.authTime*1000>300_000||identity.authTime*1000>Date.now()+30_000))throw new HTTPException(403,{message:'Recent Oathweave authentication is required for exact one-use deployment approval'});}
    c.set('auth',{username,isAdmin});
    await next(); return;
  }
  const auth = readAuth(c.req.header('cookie'));
  if (!auth) throw new HTTPException(401, { message: 'Sign in is required' });
  if (admin && !auth.isAdmin) throw new HTTPException(403, { message: 'Administrator access is required' });
  c.set('auth', auth);
  await next();
};

// Audit export readers: Oathweave service tokens with hiveskills:audit:read, or registry administrators.
const requireAuditReader: MiddlewareHandler<{ Variables: Variables }> = async (c, next): Promise<void | Response> => {
  const authorization = c.req.header('authorization');
  if (authorization && verifyIdentity && authorization.startsWith('Bearer ')) {
    let service;
    try { service = await verifyIdentity.verifyService(authorization.slice(7)); } catch (error) {
      // A validly signed user token takes the administrator path below, which verifies it again.
      if (error instanceof OathweaveError && error.reason === 'wrong_principal_kind') return requireAuth(true)(c, next);
      throw new HTTPException(401, { message: 'Invalid identity token' });
    }
    if (!service.permissions.includes(AUDIT_READ_PERMISSION)) throw new HTTPException(403, { message: 'Permission required' });
    c.set('auth', { username: `service:${service.subject}`, isAdmin: false });
    await next(); return;
  }
  return requireAuth(true)(c, next);
};

// A body that is not JSON is the caller's error, not a server fault.
const requestJson = async (c: { req: { json: () => Promise<unknown> } }): Promise<JsonObject> => {
  let body: unknown;
  try { body = await c.req.json(); } catch { throw new HTTPException(400, { message: 'Invalid JSON body' }); }
  return asObject(body);
};

const browserInput = <T>(schema:z.ZodType<T>, value:unknown):T => {
  const result=schema.safeParse(value);
  if(!result.success) throw new HTTPException(400,{message:'Invalid registry request'});
  return result.data;
};

const archiveUrl = (skillSlug: string, release: Release, channel: string): string => {
  const base = `${config.publicUrl}/v1/skills/${skillSlug}/releases/${release.version}/archive`;
  return channel === 'stable' ? base : `${base}?channel=${channel}`;
};

// Echo or assign x-request-id (and W3C trace context) on every response, maintenance included.
app.use('*', requestContext());
app.use('*', async (c,next)=>{if(maintenanceActive(new URL(c.req.url).pathname))return c.json({error:'Hive is undergoing maintenance'},503);await next();});
// Request body limits. Only a release upload carries an archive; every other body, including the
// unauthenticated sign-in, is small. The limit holds while the body streams, without a
// Content-Length and against a wrong one.
export const MAX_JSON_BODY_BYTES = 64 * 1024;
/** 1000 receipt entries of the longest slug, version and digest fit with room to spare. */
export const MAX_RECEIPT_BODY_BYTES = 256 * 1024;
/** A 50 MiB archive in base64 plus the release fields. */
export const MAX_UPLOAD_JSON_BYTES = 70 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const tooLarge = (c: Context) => c.json({ error: 'Request body is too large' }, 413);
const limits = {
  json: bodyLimit({ maxSize: MAX_JSON_BODY_BYTES, onError: tooLarge }),
  receipt: bodyLimit({ maxSize: MAX_RECEIPT_BODY_BYTES, onError: tooLarge }),
  uploadJson: bodyLimit({ maxSize: MAX_UPLOAD_JSON_BYTES, onError: tooLarge }),
  uploadArchive: bodyLimit({ maxSize: MAX_ARCHIVE_BYTES, onError: tooLarge }),
};
const uploadRoute = /^\/admin\/skills\/[^/]+\/releases$/;
const receiptRoute = /^\/v1\/agent\/receipts\/[^/]+$/;
/** A raw release upload: `application/gzip` (or the older `application/x-gzip`), parameters allowed. */
const isGzipUpload = (contentType: string | undefined): boolean =>
  /^application\/(?:x-)?gzip\s*(?:;|$)/i.test(contentType ?? '');
app.use('*', (c, next) => {
  if (c.req.method === 'POST' && uploadRoute.test(c.req.path)) return (isGzipUpload(c.req.header('content-type')) ? limits.uploadArchive : limits.uploadJson)(c, next);
  if (c.req.method === 'POST' && receiptRoute.test(c.req.path)) return limits.receipt(c, next);
  return limits.json(c, next);
});

for (const target of config.targets) store.seedTarget(target);

// nosniff, no-referrer and frame DENY, set before each handler runs.
app.use('*', securityHeaders());

// The standalone web UI is retired; HiveXUI is the UI.
app.get('/', (c) => hiveXuiStubResponse(c, config.hivexuiUrl));
const serviceMetadata = metadata(releasePackageRoot);
app.get('/health/live', (c) => c.json({ ...serviceMetadata, status: 'ok', service: 'hive-skills', capabilities: SERVICE_CAPABILITIES }));
// The readiness check stats every promoted archive. Unauthenticated probes share one run for a few
// seconds instead of each repeating it; a failing database is never cached.
export const READINESS_CACHE_MS = 5_000;
let readinessRun: { at: number; value: { ready: boolean; missingArchives: number } } | undefined;
const readiness = (): { ready: boolean; missingArchives: number } => {
  const now = Date.now();
  if (readinessRun && now - readinessRun.at >= 0 && now - readinessRun.at < READINESS_CACHE_MS) return readinessRun.value;
  const value = store.readiness();
  readinessRun = { at: now, value };
  return value;
};
const health = createHealth({
  service: 'hive-skills',
  version: serviceMetadata.version,
  checks: [{ name: 'database', check: () => { const { ready, missingArchives } = readiness(); return { ok: ready, details: { missingArchives } }; } }],
});
// Suite-standard readiness. /health/live and /healthz keep their historical bodies for existing probes.
// Every health body also lists the service capabilities (src/capabilities.ts).
app.get('/health/ready', async (c) => {
  const result = await health.ready();
  return c.body(JSON.stringify({ ...result.body, capabilities: SERVICE_CAPABILITIES }), result.status, result.headers);
});
app.get('/healthz', (c) => {
  try {
    const health = readiness();
    return c.json({ ...serviceMetadata, status: health.ready ? 'ok' : 'degraded', service: 'hive-skills', ...health, capabilities: SERVICE_CAPABILITIES }, health.ready ? 200 : 503);
  } catch {
    return c.json({ status: 'degraded', service: 'hive-skills', reason: 'database_unavailable', capabilities: SERVICE_CAPABILITIES }, 503);
  }
});

app.get('/v1/skills', (c) => c.json(store.listSkills()));

app.get('/v1/skills/:slug', (c) => {
  const skill = store.getSkill(c.req.param('slug'));
  if (!skill || !skill.enabled) throw new HTTPException(404, { message: 'Skill not found' });
  const release = store.channelRelease(channelParam(c.req.query('channel')), skill.slug);
  return c.json({
    ...skill,
    release: release ? { version: release.version, sha256: release.sha256, notes: release.notes, createdAt: release.createdAt } : null,
  });
});

app.get('/v1/agent/manifest', (c) => {
  const target = c.req.query('target');
  const hermesVersion = c.req.query('hermes_version');
  const policy = target ? store.authenticateTarget(target, bearer(c.req.header('authorization'))) : null;
  if (target && !policy) throw new HTTPException(401, { message: 'Target enrollment required' });
  if (hermesVersion) {
    try {
      parseVersion(hermesVersion);
    } catch (error) {
      throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Invalid Hermes version' });
    }
  }
  const channel = policy?.channel ?? 'stable';
  const entries = store.activeManifest(channel, policy?.skills, hermesVersion, Boolean(target || hermesVersion));
  return c.json({
    schemaVersion: 1,
    channel,
    hermesVersion: hermesVersion ?? null,
    generatedAt: new Date().toISOString(),
    skills: entries.map(({ release, ...skill }) => ({
      slug: skill.slug,
      name: skill.name,
      version: release.version,
      sha256: release.sha256,
      compatibility: { minHermesVersion: release.minHermesVersion ?? null, maxHermesVersion: release.maxHermesVersion ?? null },
      archiveUrl: archiveUrl(skill.slug, release, channel),
    })),
  });
});

app.post('/v1/agent/receipts/:target', async (c) => {
  const target = c.req.param('target');
  if (!store.authenticateTarget(target, bearer(c.req.header('authorization')))) {
    throw new HTTPException(401, { message: 'Target enrollment required' });
  }
  const body = await requestJson(c);
  const status = text(body.status, 'status', 40);
  if (!['downloaded', 'activated', 'restart_failed', 'discovered'].includes(status)) {
    throw new HTTPException(400, { message: 'Invalid receipt status' });
  }
  const skills = asObject(body.skills);
  if (Object.keys(skills).length > 1000) throw new HTTPException(400, { message: 'Too many receipt entries' });
  const clean: Record<string, { version: string; sha256: string }> = {};
  for (const [key, value] of Object.entries(skills)) {
    const item = asObject(value);
    clean[slug(key)] = { version: text(item.version, 'version', 64), sha256: text(item.sha256, 'sha256', 64) };
  }
  store.recordReceipt(target, { status, skills: clean, receivedAt: new Date().toISOString(), attestation: 'agent-reported' });
  return c.json({ ok: true });
});

// Pinned-release readers: an enrolled target, with the same `?target=` and bearer token the agent
// manifest and receipts use and limited to the target's skill allowlist, or a registry administrator
// (session or linked Oathweave identity), who can already list every release. Never anonymous.
const requirePinnedReader = async (c: Context<{ Variables: Variables }>, skillSlug: string): Promise<void> => {
  const target = c.req.query('target');
  if (target !== undefined) {
    const policy = store.authenticateTarget(target, bearer(c.req.header('authorization')));
    if (!policy) throw new HTTPException(401, { message: 'Target enrollment required' });
    if (policy.skills && !policy.skills.includes(skillSlug)) throw new HTTPException(403, { message: 'This target is not assigned the skill' });
    return;
  }
  await requireAuth(true)(c, async () => {});
};

// A release of an enabled skill by exact version, or 404. Releases are immutable and never revoked one by
// one: disabling or deleting the skill is what takes its releases out of distribution.
const pinnedRelease = (skillSlug: string, version: string): Release => {
  const release = store.getSkill(skillSlug)?.enabled ? store.getRelease(skillSlug, version) : undefined;
  if (!release) throw new HTTPException(404, { message: 'Release not found' });
  return release;
};

// The stored archive bytes, served only when they still match the release digest. The file is
// opened once, checked and streamed from the same handle, so a file swapped in after the check is
// never served. The digest is hashed in chunks without blocking other requests, and cached by
// size, mtime and inode, so an unchanged archive is hashed once rather than on every download.
const archiveResponse = async (c: Context<{ Variables: Variables }>, release: Release): Promise<Response> => {
  let handle;
  try { handle = await open(release.archivePath, 'r'); } catch { throw new HTTPException(404, { message: 'Release archive not found' }); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new HTTPException(404, { message: 'Release archive not found' });
    if (await archiveDigest(release.archivePath, handle, stat) !== release.sha256) {
      console.error(`archive digest mismatch: ${release.skillSlug}@${release.version}`);
      return c.json({ error: 'Release archive failed its digest check' }, 500);
    }
    c.header('Content-Type', 'application/gzip');
    c.header('Content-Length', String(stat.size));
    c.header('Content-Disposition', `attachment; filename="${release.skillSlug}-${release.version}.tgz"`);
    c.header('X-Content-SHA256', release.sha256);
    const body = Readable.toWeb(handle.createReadStream({ start: 0, end: Math.max(stat.size - 1, 0) })) as ReadableStream<Uint8Array>;
    handle = undefined; // The stream owns and closes the handle.
    return c.body(body);
  } finally {
    await handle?.close();
  }
};

// Metadata of one immutable release by exact version, promoted or not (skills.pinned-release.v1).
app.get('/v1/skills/:slug/releases/:version', async (c) => {
  const skillSlug = c.req.param('slug');
  await requirePinnedReader(c, skillSlug);
  const release = pinnedRelease(skillSlug, c.req.param('version'));
  c.header('Cache-Control', 'no-store');
  return c.json(PinnedRelease.parse({
    slug: release.skillSlug,
    version: release.version,
    sha256: release.sha256,
    size: existsSync(release.archivePath) ? statSync(release.archivePath).size : null,
    notes: release.notes,
    compatibility: { minHermesVersion: release.minHermesVersion ?? null, maxHermesVersion: release.maxHermesVersion ?? null },
    channels: store.releaseChannels(release.skillSlug, release.version),
    archiveUrl: `${config.publicUrl}/v1/skills/${release.skillSlug}/releases/${release.version}/archive`,
    createdAt: release.createdAt,
  }));
});

// The release promoted on the requested channel stays public, as before. Any other immutable release of
// an enabled skill is served to a pinned-release reader (skills.pinned-release.v1); anonymous callers
// still see unpromoted, superseded and withdrawn releases as missing.
app.get('/v1/skills/:slug/releases/:version/archive', async (c) => {
  const skillSlug = c.req.param('slug');
  const version = c.req.param('version');
  const skill = store.getSkill(skillSlug);
  const promoted = store.channelRelease(channelParam(c.req.query('channel')), skillSlug);
  if (skill?.enabled && promoted?.version === version) return archiveResponse(c, promoted);
  const credentials = c.req.query('target') !== undefined || c.req.header('authorization') !== undefined || readAuth(c.req.header('cookie')) !== undefined;
  if (!credentials) throw new HTTPException(404, { message: 'Release archive not found' });
  await requirePinnedReader(c, skillSlug);
  return archiveResponse(c, pinnedRelease(skillSlug, version));
});

// The socket peer (or the client a trusted proxy forwarded for); `unknown` outside a Node server.
const requestSource = (c: Context): string => {
  let peer: string | undefined;
  try { peer = getConnInfo(c).remote.address; } catch { peer = undefined; }
  return clientAddress(peer, c.req.header('x-forwarded-for'), config.trustedProxies);
};

app.post('/auth/login', async (c) => {
  const body = await requestJson(c);
  const username = text(body.username, 'username', 32);
  const password = text(body.password, 'password', 1024);
  // A name no OS account can have never reaches PAM, so it must not occupy a throttle slot either.
  if (!validUsername(username)) throw new HTTPException(401, { message: 'OS authentication failed' });
  const source = requestSource(c);
  const refusal = loginThrottle.refusal(username, source);
  if (refusal) {
    // Audited once per delay or window, so a flood of refused attempts cannot flood the audit log.
    if (refusal.first) store.audit(username, 'login.failed', 'session', { username, source, throttled: true, throttle: refusal.reason, retryAfterSeconds: refusal.retryAfterSeconds });
    throw new HTTPException(429, { message: 'Try again shortly', res: new Response(null, { headers: { 'retry-after': String(refusal.retryAfterSeconds) } }) });
  }
  if (!await authenticateOsUser(username, password)) {
    const state = loginThrottle.failed(username, source);
    store.audit(username, 'login.failed', 'session', { username, source, throttled: false, accountDelaySeconds: state.accountDelaySeconds, sourceFailures: state.sourceFailures });
    throw new HTTPException(401, { message: 'OS authentication failed' });
  }
  loginThrottle.succeeded(username);
  const token = createSession(username);
  c.header('Set-Cookie', sessionCookie(token));
  store.audit(username, 'login', 'session', {});
  return c.json({ username, isAdmin: config.adminUsers.has(username) });
});

app.post('/auth/logout', (c) => {
  // Only a session this registry issued is revoked and audited; other cookies are just cleared.
  const username = removeSession(c.req.header('cookie'));
  c.header('Set-Cookie', sessionCookie('', 0));
  if (username) store.audit(username, 'logout', 'session', {});
  return c.body(null, 204);
});

app.get('/auth/me', requireAuth(), (c) => c.json(c.get('auth')));

app.get('/admin/skills', requireAuth(true), (c) => c.json(store.listAllSkills()));
app.get('/admin/skills/:slug/releases', requireAuth(true), (c) => c.json(store.listReleases(c.req.param('slug')).map(release=>BrowserRelease.parse(release))));
app.get('/admin/audit', requireAuth(true), (c) => {
  const limit=Number(c.req.query('limit') ?? 50),before=Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER);
  if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(before)||before<1)throw new HTTPException(400,{message:'Invalid audit page'});
  return c.json(store.listAudit(limit,before));
});
app.get('/admin/updates', requireAuth(true), async (c) => c.json(await updateStatus(metadata(releasePackageRoot).release, upgradeHome())));

app.post('/admin/skills', requireAuth(true), async (c) => {
  const body = browserInput(CreateSkill, await requestJson(c));
  const skill = store.createSkill({
    slug: slug(body.slug),
    name: text(body.name, 'name', 120),
    description: text(body.description, 'description', 5_000),
    homepage: optionalText(body.homepage, 'homepage', 2_000),
    enabled: body.enabled === undefined ? true : body.enabled === true,
  });
  store.audit(c.get('auth').username, 'skill.create', skill.slug, {});
  return c.json(skill, 201);
});

app.patch('/admin/skills/:slug', requireAuth(true), async (c) => {
  const body = browserInput(UpdateSkill, await requestJson(c));
  const skill = store.updateSkill(c.req.param('slug'), {
    name: body.name === undefined ? undefined : text(body.name, 'name', 120),
    description: body.description === undefined ? undefined : text(body.description, 'description', 5_000),
    homepage: body.homepage === undefined ? undefined : optionalText(body.homepage, 'homepage', 2_000),
    enabled: body.enabled === undefined ? undefined : body.enabled === true,
  });
  if (!skill) throw new HTTPException(404, { message: 'Skill not found' });
  store.audit(c.get('auth').username, 'skill.update', skill.slug, {});
  return c.json(skill);
});

app.delete('/admin/skills/:slug', requireAuth(true), (c) => {
  const existing = store.getSkill(c.req.param('slug'));
  if (!existing || !store.deleteSkill(existing.slug)) throw new HTTPException(404, { message: 'Skill not found' });
  store.audit(c.get('auth').username, 'skill.delete', existing.slug, {});
  return c.body(null, 204);
});

// A release upload is either JSON with `archiveBase64`, or the raw archive bytes as
// `application/gzip` with the release fields in the query string, which avoids holding a base64
// string of the archive in memory.
app.post('/admin/skills/:slug/releases', requireAuth(true), async (c) => {
  const skillId = c.req.param('slug');
  if (!store.getSkill(skillId)) throw new HTTPException(404, { message: 'Skill not found' });
  let body: { version: string; notes?: string | null | undefined; minHermesVersion?: string | null | undefined; maxHermesVersion?: string | null | undefined };
  let archiveBytes: () => Promise<Buffer>;
  if (isGzipUpload(c.req.header('content-type'))) {
    const query = new URL(c.req.url).searchParams;
    body = browserInput(UploadArchiveQuery, Object.fromEntries([...query.keys()].map((key) => [key, query.getAll(key).length === 1 ? query.get(key) : query.getAll(key)])));
    archiveBytes = async () => Buffer.from(await c.req.arrayBuffer());
  } else {
    const json = browserInput(UploadRelease, await requestJson(c));
    body = json;
    archiveBytes = async () => Buffer.from(text(json.archiveBase64, 'archiveBase64', MAX_UPLOAD_JSON_BYTES), 'base64');
  }
  const version = text(body.version, 'version', 64);
  try {
    assertSkillId(skillId, version);
  } catch (error) {
    throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Invalid version' });
  }
  if (store.getRelease(skillId, version)) throw new HTTPException(409, { message: 'Releases are immutable; this version already exists' });
  const minHermesVersion = optionalText(body.minHermesVersion, 'minHermesVersion', 64);
  const maxHermesVersion = optionalText(body.maxHermesVersion, 'maxHermesVersion', 64);
  try {
    if (minHermesVersion) parseVersion(minHermesVersion);
    if (maxHermesVersion) parseVersion(maxHermesVersion);
    if (minHermesVersion && maxHermesVersion && compareVersions(minHermesVersion, maxHermesVersion) > 0) {
      throw new Error('Minimum Hermes version exceeds maximum');
    }
  } catch (error) {
    throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Invalid compatibility range' });
  }
  const archive = await archiveBytes();
  let persisted: { path: string; sha256: string };
  try {
    persisted = persistArchive(skillId, version, archive);
  } catch (error) {
    throw new HTTPException(400, { message: error instanceof Error ? error.message : 'Invalid archive' });
  }
  const release = {
    skillSlug: skillId,
    version,
    sha256: persisted.sha256,
    archivePath: persisted.path,
    notes: optionalText(body.notes, 'notes', 5_000),
    minHermesVersion,
    maxHermesVersion,
    createdAt: new Date().toISOString(),
  };
  try {
    store.addRelease(release);
  } catch (error) {
    removeArchive(persisted.path);
    throw error;
  }
  store.audit(c.get('auth').username, 'release.create', `${skillId}@${version}`, { sha256: persisted.sha256, minHermesVersion, maxHermesVersion });
  return c.json(BrowserRelease.parse(release), 201);
});

app.get('/admin/channels', requireAuth(true), (c) => c.json(store.listChannels()));
// Optional exact target filter; without it the historical listing is returned unchanged.
app.get('/admin/receipts', requireAuth(true), (c) => {
  const query = ReceiptQuery.safeParse({ targetId: c.req.query('targetId') });
  if (!query.success) throw new HTTPException(400, { message: 'Invalid receipt filter' });
  return c.json(store.listReceipts(query.data.targetId));
});

// HiveEvent v1 feed for the HiveXUI inbox, derived from deployment jobs, agent receipts and the
// registry audit log. Same access as the receipt and deployment reads: registry administrators only.
app.get('/v1/hive/events', requireAuth(true), (c) => {
  let limit: number, position: FeedPosition | null | undefined;
  try {
    const query = parseFeedQuery(new URL(c.req.url).searchParams);
    limit = query.limit;
    position = query.after === undefined ? undefined : decodePosition(query.after);
  } catch {
    throw new HTTPException(400, { message: 'Invalid event feed query' });
  }
  if (position === null) throw new HTTPException(400, { message: 'Invalid event feed cursor' });
  const now = Date.now();
  const page = hiveEventPage(store.hiveEventRecords(feedSince(position, now)), position, limit, now,
    (count) => console.warn(`hive events: dropped ${count} invalid event(s)`));
  c.header('Cache-Control', 'no-store');
  return c.json(page);
});

// Suite audit export (HiveAuditRecord v1) for Cindertrace: every stored audit row, oldest first by id.
app.get('/v1/audit/export', requireAuditReader, (c) => {
  let limit: number, afterId = 0;
  try {
    const query = parseFeedQuery(new URL(c.req.url).searchParams, { defaultLimit: AUDIT_EXPORT_DEFAULT_LIMIT, maxLimit: AUDIT_EXPORT_MAX_LIMIT });
    limit = query.limit;
    if (query.after !== undefined) {
      const decoded = decodeAuditCursor(query.after);
      if (decoded === null) throw new Error('cursor');
      afterId = decoded;
    }
  } catch {
    throw new HTTPException(400, { message: 'Invalid audit export query' });
  }
  const page = auditExportPage(store.auditExportRows(afterId, limit), limit,
    (count) => console.warn(`audit export: skipped ${count} unmappable record(s)`));
  c.header('Cache-Control', 'no-store');
  return c.json(page);
});

app.put('/admin/channels/:channel/:slug', requireAuth(true), async (c) => {
  const channel = channelParam(c.req.param('channel'));
  const body = browserInput(PromoteRelease, await requestJson(c));
  const version = text(body.version, 'version', 64);
  const skill = c.req.param('slug');
  if (!store.getRelease(skill, version)) throw new HTTPException(404, { message: 'Release not found' });
  store.promoteRelease(skill, version, channel);
  store.audit(c.get('auth').username, 'release.promote', skill, { channel, version });
  return c.json({ ok: true });
});

app.delete('/admin/channels/:channel/:slug', requireAuth(true), (c) => {
  const channel = channelParam(c.req.param('channel'));
  store.withdrawRelease(c.req.param('slug'), channel);
  store.audit(c.get('auth').username, 'release.withdraw', c.req.param('slug'), { channel });
  return c.body(null, 204);
});

// Optional exact magnusNodeId filter; without it the historical listing is returned unchanged.
app.get('/admin/targets', requireAuth(true), (c) => {
  const query = TargetQuery.safeParse({ nodeId: c.req.query('nodeId') });
  if (!query.success) throw new HTTPException(400, { message: 'Invalid target filter' });
  return c.json(store.listTargets(query.data.nodeId));
});

app.put('/admin/targets/:target', requireAuth(true), async (c) => {
  const body = browserInput(UpdateTarget, await requestJson(c));
  const name = slug(c.req.param('target'));
  const host = text(body.host, 'host', 253);
  const username = text(body.username, 'username', 32);
  const validHost = /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host);
  const validUser = /^[a-z_][a-z0-9_-]*$/i.test(username);
  if (!validHost || !validUser || (body.enabled !== undefined && typeof body.enabled !== 'boolean')) {
    throw new HTTPException(400, { message: 'Invalid target' });
  }
  // Omitted fleet fields keep the stored binding so older clients cannot erase it.
  let binding: TargetBinding | null | undefined;
  if (body.magnusNodeId !== undefined || body.agentRefs !== undefined) {
    const current = store.targetBinding(name);
    const magnusNodeId = body.magnusNodeId === undefined ? current?.magnusNodeId ?? null : body.magnusNodeId;
    // Clearing the node clears its agents with it; only explicitly sent agents can conflict.
    const agentRefs = body.agentRefs === undefined ? (magnusNodeId === null ? [] : current?.agentRefs ?? []) : [...new Set(body.agentRefs)];
    if (agentRefs.some((ref) => ref.slice(0, ref.indexOf('~')) !== magnusNodeId)) throw new HTTPException(400, { message: 'Invalid target' });
    binding = magnusNodeId === null ? null : { magnusNodeId, agentRefs };
  }
  store.saveTarget({ name, host, username, enabled: body.enabled !== false }, binding);
  store.audit(c.get('auth').username, 'target.update', name, { host, username, enabled: body.enabled !== false, ...(binding === undefined ? {} : { magnusNodeId: binding?.magnusNodeId ?? null, agentRefs: binding?.agentRefs.length ?? 0 }) });
  return c.json({ ok: true });
});

app.post('/admin/targets/:target/enroll', requireAuth(true), async (c) => {
  const target = c.req.param('target');
  if (!store.getTarget(target)) throw new HTTPException(404, { message: 'Target not found' });
  const body = browserInput(EnrollTarget, await requestJson(c));
  const channel = channelParam(text(body.channel, 'channel', 20));
  const skills = body.skills === undefined ? null : Array.isArray(body.skills) ? body.skills.map(slug) : null;
  if (body.skills !== undefined && skills === null) throw new HTTPException(400, { message: 'skills must be an array' });
  const token = store.enrollTarget(target, channel, skills);
  store.audit(c.get('auth').username, 'target.enroll', target, { channel });
  return c.json({ target, token, oneTime: true }, 201);
});

app.get('/admin/deployments/capabilities',requireAuth(true),c=>c.json({enabled:Boolean(magnusExecutorConfiguration()),executor:'magnus',message:magnusExecutorConfiguration()?'Exact publication previews and one-use approvals are available':'Configure the Magnus executor and native target client before deployment'}));
app.get('/admin/deployments', requireAuth(true), (c) => c.json(store.listDeployments()));

app.post('/admin/deployments/:target', requireAuth(true), (c) => {
  const target = store.getTarget(c.req.param('target'));
  if (!target) throw new HTTPException(404, { message: 'Deployment target not found or disabled' });
  // Suite deployments always use the owned, approved Magnus operation. The
  // standalone native console retains its historical recovery route when unset.
  if(process.env.HIVE_SKILLS_MAGNUS_EXECUTOR_JSON){
    requireMagnusExecutor();
    const policy=store.targetPolicy(target.name);if(!policy)throw new HTTPException(409,{message:'Enroll the native target before preparing its deployment'});
    const manifest:Publication={schemaVersion:1,channel:policy.channel,skills:store.activeManifest(policy.channel,policy.skills,undefined,false).map(({release,...skill})=>({slug:skill.slug,name:skill.name,version:release.version,sha256:release.sha256,compatibility:{minHermesVersion:release.minHermesVersion??null,maxHermesVersion:release.maxHermesVersion??null},archiveUrl:archiveUrl(skill.slug,release,policy.channel)}))};
    const job=deploymentJournal.preview(target.name,c.get('auth').username,manifest);
    store.audit(c.get('auth').username,'deployment.prepared',target.name,{id:job.id,publicationSha256:job.publication_sha256});c.header('Cache-Control','no-store');return c.json(job,201);
  }
  const id = store.createDeployment(target.name, c.get('auth').username);
  store.audit(c.get('auth').username, 'deployment.queued', target.name, { id });
  return c.json({ id, status: 'queued', target: target.name }, 202);
});

app.get('/admin/deployments/jobs/:id',requireAuth(true),c=>{c.header('Cache-Control','no-store');return c.json(deploymentJournal.get(c.req.param('id')))});
app.post('/admin/deployments/jobs/:id/approve',requireAuth(true),async c=>{
 const parsed=z.object({publicationSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().safeParse(await c.req.json().catch(()=>null));if(!parsed.success)throw new HTTPException(400,{message:'Exact publication digest is required'});
 requireMagnusExecutor();if(!store.getTarget(String(deploymentJournal.get(c.req.param('id')).target)))throw new HTTPException(409,{message:'Target was disabled before approval'});const job=deploymentJournal.approve(c.req.param('id'),c.get('auth').username,parsed.data.publicationSha256);store.audit(c.get('auth').username,'deployment.approved',String(job.target),{id:job.id,publicationSha256:job.publication_sha256});return c.json(job,202);
});
app.post('/admin/deployments/jobs/:id/reconcile',requireAuth(true),async c=>{
 requireMagnusExecutor();const id=c.req.param('id'),job=deploymentJournal.get(id);if(!['running','unknown'].includes(String(job.status)))throw new HTTPException(409,{message:'Only an existing uncertain dispatch can be reconciled'});
 const reply=await executeMagnusJob(id,true);deploymentJournal.outcome(id,reply.status==='running'?'unknown':reply.status==='not_admitted'?'failed':reply.status,reply.result,reply.jobId);store.audit(c.get('auth').username,'deployment.reconciled',String(job.target),{id,status:reply.status});return c.json(deploymentJournal.get(id));
});

app.onError((error, c) => {
  const status = error instanceof HTTPException ? error.status : 500;
  if (status === 500) console.error(error);
  const response = c.json({ error: status >= 500 ? 'Internal server error' : error.message }, status);
  const retryAfter = error instanceof HTTPException ? error.res?.headers.get('retry-after') : null;
  if (retryAfter) response.headers.set('retry-after', retryAfter);
  return response;
});

export default app;
