import { parseAccountLinks, linkedLocalId } from './account-links.js';
import { configuredOathweaveVerifier } from './identity.js';
import { OathweaveError } from '@hivemagnus/hive-common/oathweave';
import { AUDIT_EXPORT_DEFAULT_LIMIT, AUDIT_EXPORT_MAX_LIMIT, AUDIT_READ_PERMISSION, auditExportPage, decodeAuditCursor } from './audit-export.js';
import { createHealth } from '@hivemagnus/hive-common/health';
import { requestContext } from '@hivemagnus/hive-common/hono';
import { parseFeedQuery } from '@hivemagnus/hive-common/events';
import { decodePosition, feedSince, hiveEventPage, type FeedPosition } from './hive-events.js';
import { maintenanceActive } from './release/runtime.js';
import { metadata } from './release/runtime.js';
import { packageRoot as releasePackageRoot } from './paths.js';
import { home as upgradeHome, updateStatus } from './release/runtime.js';
import { bodyLimit } from 'hono/body-limit';
import { existsSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { MiddlewareHandler } from 'hono';
import { config } from './config.js';
import { persistArchive, assertSkillId, removeArchive } from './archive.js';
import { authenticateOsUser, createSession, readAuth, removeSession, sessionCookie } from './auth.js';
import { store, deploymentJournal } from './db.js';
import { requireMagnusExecutor, executeMagnusJob, magnusExecutorConfiguration } from './magnus-deployment.js';
import { type Publication } from './deployment-journal.js';
import { z } from 'zod';
import { hiveXuiStubResponse } from './hivexui-stub.js';
import type { AuthContext, Release, TargetBinding } from './types.js';
import { compareVersions, parseVersion } from './compatibility.js';
import { Release as BrowserRelease, CreateSkill, UpdateSkill, UploadRelease, UpdateTarget, PromoteRelease, EnrollTarget, TargetQuery, ReceiptQuery } from './browser-contracts.js';

type Variables = { auth: AuthContext };
type JsonObject = Record<string, unknown>;

const app = new Hono<{ Variables: Variables }>();
const verifyIdentity = configuredOathweaveVerifier();
const accountLinks=parseAccountLinks(process.env.HIVESKILLS_OATHWEAVE_IDENTITIES_JSON??'[]');
const loginAttempts = new Map<string, number>();
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

const requestJson = async (c: { req: { json: () => Promise<unknown> } }): Promise<JsonObject> => asObject(await c.req.json());

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
app.use('*', bodyLimit({ maxSize: 70 * 1024 * 1024 }));

for (const target of config.targets) store.seedTarget(target);

app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  await next();
});

// The standalone web UI is retired; HiveXUI is the UI.
app.get('/', (c) => hiveXuiStubResponse(c, config.hivexuiUrl));
app.get('/health/live', (c) => c.json({ ...metadata(releasePackageRoot), status: 'ok', service: 'hive-skills' }));
const health = createHealth({
  service: 'hive-skills',
  version: metadata(releasePackageRoot).version,
  checks: [{ name: 'database', check: () => { const { ready, missingArchives } = store.readiness(); return { ok: ready, details: { missingArchives } }; } }],
});
// Suite-standard readiness. /health/live and /healthz keep their historical bodies for existing probes.
app.get('/health/ready', async (c) => {
  const result = await health.ready();
  return c.body(JSON.stringify(result.body), result.status, result.headers);
});
app.get('/healthz', (c) => {
  try {
    const health = store.readiness();
    return c.json({ ...metadata(releasePackageRoot), status: health.ready ? 'ok' : 'degraded', service: 'hive-skills', ...health }, health.ready ? 200 : 503);
  } catch {
    return c.json({ status: 'degraded', service: 'hive-skills', reason: 'database_unavailable' }, 503);
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

// Only the release currently promoted on the requested channel is downloadable;
// unpromoted, superseded and withdrawn releases are reported as missing.
app.get('/v1/skills/:slug/releases/:version/archive', (c) => {
  const skillSlug = c.req.param('slug');
  const version = c.req.param('version');
  const skill = store.getSkill(skillSlug);
  const promoted = store.channelRelease(channelParam(c.req.query('channel')), skillSlug);
  if (!skill?.enabled || !promoted || promoted.version !== version || !existsSync(promoted.archivePath)) {
    throw new HTTPException(404, { message: 'Release archive not found' });
  }
  c.header('Content-Type', 'application/gzip');
  c.header('Content-Disposition', `attachment; filename="${skillSlug}-${version}.tgz"`);
  c.header('X-Content-SHA256', promoted.sha256);
  return c.body(readFileSync(promoted.archivePath));
});

app.post('/auth/login', async (c) => {
  const body = await requestJson(c);
  const username = text(body.username, 'username', 32);
  const password = text(body.password, 'password', 1024);
  for (const [key, expires] of loginAttempts) if (expires <= Date.now()) loginAttempts.delete(key);
  if (loginAttempts.size >= 1000 && !loginAttempts.has(username)) throw new HTTPException(429, { message: 'Try again shortly' });
  const previous = loginAttempts.get(username) ?? 0;
  if (previous > Date.now()) throw new HTTPException(429, { message: 'Try again shortly' });
  if (!await authenticateOsUser(username, password)) {
    loginAttempts.set(username, Date.now() + 15_000);
    throw new HTTPException(401, { message: 'OS authentication failed' });
  }
  loginAttempts.delete(username);
  const token = createSession(username);
  c.header('Set-Cookie', sessionCookie(token));
  store.audit(username, 'login', 'session', {});
  return c.json({ username, isAdmin: config.adminUsers.has(username) });
});

app.post('/auth/logout', (c) => {
  const id = removeSession(c.req.header('cookie'));
  c.header('Set-Cookie', sessionCookie('', 0));
  if (id) store.audit('unknown', 'logout', id, {});
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

app.post('/admin/skills/:slug/releases', requireAuth(true), async (c) => {
  const skillId = c.req.param('slug');
  if (!store.getSkill(skillId)) throw new HTTPException(404, { message: 'Skill not found' });
  const body = browserInput(UploadRelease, await requestJson(c));
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
  const archive = text(body.archiveBase64, 'archiveBase64', 70 * 1024 * 1024);
  let persisted: { path: string; sha256: string };
  try {
    persisted = persistArchive(skillId, version, Buffer.from(archive, 'base64'));
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
  const page = auditExportPage(store.auditExportRows(afterId, limit + 1), limit,
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
    const agentRefs = body.agentRefs === undefined ? current?.agentRefs ?? [] : [...new Set(body.agentRefs)];
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
  return c.json({ error: status >= 500 ? 'Internal server error' : error.message }, status);
});

export default app;
