import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { encodeCursor } from '@hivemagnus/hive-common/events';

const temporary = mkdtempSync(join(tmpdir(), 'hive-skills-audit-export-test-'));
process.env.HIVE_AUTO_MIGRATE = 'true';
process.env.HIVE_SKILLS_DATA_DIR = temporary;
process.env.HIVE_SKILLS_SESSION_SECRET = 'audit-export-test-secret-0123456789abcdef';
process.env.HIVE_SKILLS_ADMIN_USERS = 'admin';
process.env.HIVE_SKILLS_PUBLIC_URL = 'https://registry.test:4030';
process.env.HIVE_SKILLS_TARGETS = 'agent-1=deploy@agent-host.test,agent-2=deploy@other-host.test';
process.env.OATHWEAVE_ISSUER = 'https://identity.example.com';
process.env.OATHWEAVE_JWKS_URL = 'https://identity.example.com/jwks';
process.env.OATHWEAVE_USERINFO_URL = 'https://identity.example.com/userinfo';
process.env.OATHWEAVE_NATIVE_ISSUERS = 'fake-native-issuer';
process.env.HIVESKILLS_OATHWEAVE_IDENTITIES_JSON = JSON.stringify([
  { issuer: 'https://identity.example.com', subject: 'fake-admin', localId: 'admin' },
  { issuer: 'https://identity.example.com', subject: 'fake-reader', localId: 'reader' },
]);
const keys = await generateKeyPair('RS256');
const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'test' }] };
const originalFetch = globalThis.fetch;
// Userinfo answers for whichever subject the presented token names.
globalThis.fetch = async (input, init) => {
  if (String(input).endsWith('/jwks')) return Response.json(jwks);
  const token = new Headers(init?.headers).get('authorization')?.split(' ')[1] ?? '';
  return Response.json({ sub: (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { sub: string }).sub });
};

await (await import('./upgrade.js')).skillsMigration([], true);
const { config } = await import('./config.js');
const { DatabaseSync } = await import('./sqlite.js');
const app = (await import('./app.js')).default;
const { createSession } = await import('./auth.js');
const { HiveAuditPage, HiveAuditRecord } = await import('./browser-contracts.js');
const { auditRecord } = await import('./audit-export.js');

after(() => {
  globalThis.fetch = originalFetch;
  rmSync(temporary, { recursive: true, force: true });
});

const url = 'https://registry.test';
const adminToken = createSession('admin');
const admin = 'hive_skills_session=' + adminToken;
const reader = 'hive_skills_session=' + createSession('reader');
const db = new DatabaseSync(config.databasePath);
const revokedSessionId = 'fake-revoked-session-id-0123456789abcdefghij';
const audit = (actor: string, action: string, subject: string, details: Record<string, unknown> | string, created = new Date().toISOString()) =>
  db.prepare('INSERT INTO audit_log (actor, action, subject, details, created_at) VALUES (?,?,?,?,?)')
    .run(actor, action, subject, typeof details === 'string' ? details : JSON.stringify(details), created);

type Claims = Record<string, unknown>;
const sign = (subject: string, claims: Claims, issuer = process.env.OATHWEAVE_ISSUER!, audience = 'hiveskills') =>
  new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setSubject(subject).setIssuer(issuer)
    .setAudience(audience).setJti('fake-jti').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
const serviceToken = (permissions: string[], issuer?: string, audience?: string) =>
  sign('cindertrace', { actorType: 'SERVICE_ACCOUNT', token_type: 'access', clientId: 'cindertrace', roles: [], permissions }, issuer, audience);
const userToken = (subject: string, permissions: string[]) =>
  sign(subject, { actorType: 'USER', sessionId: 'fake-session', clientId: 'hivexui-hiveskills', roles: ['SUPER_ADMIN'], permissions });

type Page = { data: Array<Record<string, any>>; nextCursor: string | null };
const exportPage = async (query = '', headers: Record<string, string> = { cookie: admin }) => {
  const response = await app.request(`${url}/v1/audit/export${query}`, { headers });
  return { status: response.status, text: await response.text(), headers: response.headers };
};
const read = async (query = '', headers?: Record<string, string>): Promise<Page> => {
  const response = await exportPage(query, headers);
  assert.equal(response.status, 200, response.text);
  return JSON.parse(response.text) as Page;
};
const walk = async (limit: number): Promise<Array<Record<string, any>>> => {
  const records: Array<Record<string, any>> = [];
  let cursor: string | null = null;
  do {
    const page: Page = await read(`?limit=${limit}${cursor ? `&after=${cursor}` : ''}`);
    assert.ok(page.data.length <= limit);
    records.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return records;
};

test('seed audit records through the API and storage', async () => {
  const bind = await app.request(`${url}/admin/targets/agent-1`, { method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ host: 'agent-host.test', username: 'deploy', magnusNodeId: 'node-a', agentRefs: ['node-a~ops'] }) });
  assert.equal(bind.status, 200);
  const enroll = await app.request(`${url}/admin/targets/agent-1/enroll`, { method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'stable' }) });
  assert.equal(enroll.status, 201);
  const skill = await app.request(`${url}/admin/skills`, { method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'fixture', name: 'Fixture', description: 'Test fixture' }) });
  assert.equal(skill.status, 201);
  audit('admin', 'login', 'session', {});
  audit('unknown', 'logout', revokedSessionId, {});
  audit('admin', 'release.create', 'fixture@1.0.0', { sha256: 'a'.repeat(64), minHermesVersion: null, maxHermesVersion: '2.0.0' });
  audit('admin', 'release.promote', 'fixture', { channel: 'stable', version: '1.0.0' });
  audit('admin', 'deployment.prepared', 'agent-1', { id: '00000000-0000-4000-8000-000000000001', publicationSha256: 'b'.repeat(64) });
  audit('admin', 'deployment.queued', 'agent-2', { id: '00000000-0000-4000-8000-000000000002' });
  audit('system', 'seed', 'fixture@0.1.0', { source: 'HIVEMEM_ARCHIVE' });
  // Defensive cases: secrets in details, nested values, oversized details, odd names and bad rows.
  audit('admin', 'skill.update', 'fixture', { token: 'fake-secret-value-abc', password: 'fake-password-value', nested: { deep: true }, list: [1] });
  audit('admin', 'skill.update', 'fixture', Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`key${index}`, 'x'.repeat(80)])));
  audit('admin', 'Weird Action!', 'thing', 'not json');
  audit('admin', 'skill.delete', 'gone', {}, 'not-a-date');
  audit('admin', 'skill.delete', 'fixture', {});
});

test('requires a token or session: service tokens need hiveskills:audit:read, users need registry administration', async () => {
  assert.equal((await exportPage('', {})).status, 401);
  assert.equal((await exportPage('', { authorization: 'Bearer not-a-token' })).status, 401);
  assert.equal((await exportPage('', { authorization: 'Basic abc' })).status, 401);
  assert.equal((await exportPage('', { cookie: reader })).status, 403);
  assert.equal((await exportPage('', { cookie: admin })).status, 200);
  const bearer = async (token: Promise<string>) => (await exportPage('', { authorization: `Bearer ${await token}` })).status;
  assert.equal(await bearer(serviceToken(['hiveskills:audit:read'])), 200);
  assert.equal(await bearer(serviceToken(['hiveskills:audit:read'], 'fake-native-issuer')), 200);
  assert.equal(await bearer(serviceToken(['hiveskills:audit:read'], 'other-native-issuer')), 401);
  assert.equal(await bearer(serviceToken(['hiveskills:audit:read'], undefined, 'hivemem')), 401);
  assert.equal(await bearer(serviceToken(['hiveskills:read'])), 403);
  assert.equal(await bearer(serviceToken(['hiveskills:admin'])), 403);
  assert.equal(await bearer(serviceToken([])), 403);
  assert.equal(await bearer(userToken('fake-admin', ['hiveskills:read'])), 200);
  assert.equal(await bearer(userToken('fake-reader', ['hiveskills:read', 'hiveskills:audit:read'])), 403);
  assert.equal(await bearer(userToken('fake-admin', [])), 403);
  // Service tokens stay read-only and cannot reach the registry's other admin reads.
  const service = `Bearer ${await serviceToken(['hiveskills:audit:read'])}`;
  assert.equal((await app.request(`${url}/admin/audit`, { headers: { authorization: service } })).status, 401);
  // The historical administrator audit listing is unchanged.
  const legacy = await app.request(`${url}/admin/audit?limit=2`, { headers: { cookie: admin } });
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json() as unknown[]).length, 2);
});

test('every record passes the strict HiveAuditRecord v1 schema', async () => {
  const page = await read('?limit=200');
  assert.equal(HiveAuditPage.safeParse(page).success, true);
  for (const record of page.data) {
    assert.equal(HiveAuditRecord.safeParse(record).success, true, JSON.stringify(record));
    assert.equal(record.product, 'hiveskills');
    assert.match(record.id, /^hiveskills:audit:\d+$/);
    assert.equal(record.outcome, 'success');
    assert.ok(new TextEncoder().encode(JSON.stringify(record.details)).length <= 4096);
    for (const value of Object.values(record.details)) assert.ok(['string', 'number', 'boolean'].includes(typeof value));
  }
});

test('maps actions, actors, targets and fleet subjects', async () => {
  const records = (await read('?limit=200')).data;
  const find = (action: string, targetId?: string) => records.find((record) => record.action === action && (targetId === undefined || record.target?.id === targetId));
  assert.deepEqual(find('target.update', 'agent-1')?.subject, { nodeId: 'node-a', agentRef: 'node-a~ops' });
  assert.deepEqual(find('target.enroll', 'agent-1')?.subject, { nodeId: 'node-a', agentRef: 'node-a~ops' });
  assert.deepEqual(find('deployment.prepare', 'agent-1')?.subject, { nodeId: 'node-a', agentRef: 'node-a~ops' });
  assert.deepEqual(find('deployment.prepare', 'agent-1')?.details, { id: '00000000-0000-4000-8000-000000000001', publicationSha256: 'b'.repeat(64) });
  assert.equal(find('deployment.queue', 'agent-2')?.subject, undefined);
  assert.deepEqual(find('skill.create')?.target, { type: 'skill', id: 'fixture' });
  assert.deepEqual(find('skill.create')?.actor, { type: 'user', id: 'admin' });
  assert.equal(find('skill.create')?.subject, undefined);
  assert.deepEqual(find('release.create')?.target, { type: 'release', id: 'fixture@1.0.0' });
  assert.deepEqual(find('release.create')?.details, { sha256: 'a'.repeat(64), maxHermesVersion: '2.0.0' });
  assert.deepEqual(find('release.promote')?.details, { channel: 'stable', version: '1.0.0' });
  assert.deepEqual(find('release.seed')?.actor, { type: 'system', id: 'system' });
  assert.deepEqual(find('session.login')?.target, { type: 'session' });
  assert.ok(find('audit.weird_action_'));
  // A row with an unreadable timestamp is skipped; the next one is still served.
  assert.equal(records.filter((record) => record.action === 'skill.delete').length, 1);
  // A subject that names a target only links for target actions.
  assert.equal(auditRecord({ id: 1, actor: 'admin', action: 'skill.update', subject: 'agent-1', details: '{}', createdAt: new Date().toISOString(), magnusNodeId: 'node-a', agentRefs: [] })?.subject, undefined);
});

test('never exports session ids, secrets or nested content', async () => {
  const page = await exportPage('?limit=200');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.ok(!page.text.includes(revokedSessionId));
  assert.ok(!page.text.includes(adminToken.split('.')[0]!));
  assert.ok(!page.text.includes('fake-secret-value-abc'));
  assert.ok(!page.text.includes('fake-password-value'));
  assert.ok(!page.text.includes('"deep"'));
  const logout = (JSON.parse(page.text) as Page).data.find((record) => record.action === 'session.logout');
  assert.deepEqual(logout?.target, { type: 'session' });
});

test('pages oldest first by id with stable ids and a cursor round trip', async () => {
  const full = await walk(200);
  const ids = full.map((record) => Number(String(record.id).split(':')[2]));
  assert.deepEqual(ids, [...ids].sort((left, right) => left - right));
  assert.equal(new Set(ids).size, ids.length);
  for (const limit of [1, 2, 3, 7]) assert.deepEqual(await walk(limit), full);
  assert.deepEqual(await walk(200), full);
  const first = await read('?limit=2');
  assert.equal(first.data.length, 2);
  const second = await read(`?limit=2&after=${first.nextCursor}`);
  assert.ok(Number(second.data[0]!.id.split(':')[2]) > Number(first.data[1]!.id.split(':')[2]));
  const last = await read(`?after=${encodeCursor({ i: 1_000_000 })}`);
  assert.deepEqual(last, { data: [], nextCursor: null });
});

test('the final page still returns its last cursor, which picks up later records', async () => {
  const full = await read('?limit=200');
  const lastId = Number(full.data.at(-1)!.id.split(':')[2]);
  assert.equal(full.nextCursor, encodeCursor({ i: lastId }));
  assert.deepEqual(await read(`?after=${full.nextCursor}`), { data: [], nextCursor: null });
  audit('admin', 'skill.update', 'later', {});
  const later = await read(`?after=${full.nextCursor}`);
  assert.deepEqual(later.data.map((record) => record.target?.id), ['later']);
  assert.equal(later.nextCursor, encodeCursor({ i: Number(later.data[0]!.id.split(':')[2]) }));
  // A page whose only row is unmappable still moves the cursor past it.
  const bad = Number((db.prepare("SELECT id FROM audit_log WHERE created_at='not-a-date'").get() as { id: number }).id);
  assert.deepEqual(await read(`?limit=1&after=${encodeCursor({ i: bad - 1 })}`), { data: [], nextCursor: encodeCursor({ i: bad }) });
  assert.equal(HiveAuditRecord.safeParse({ ...full.data[0]!, id: 'hiveskills:audit:1 2' }).success, false);
});

test('limit bounds and malformed cursors', async () => {
  // Start after the seeded rows (one has an unreadable timestamp) so every bulk row is mappable.
  const start = encodeCursor({ i: Number((db.prepare('SELECT max(id) AS id FROM audit_log').get() as { id: number }).id) });
  for (let index = 0; index < 250; index++) audit('admin', 'skill.update', `bulk-${index}`, {});
  assert.equal((await read(`?after=${start}`)).data.length, 100);
  assert.equal((await read(`?after=${start}&limit=500`)).data.length, 200);
  assert.ok((await read(`?after=${start}&limit=200`)).nextCursor);
  assert.equal((await read('?limit=1')).data.length, 1);
  for (const query of ['?limit=0', '?limit=-1', '?limit=abc', '?limit=1.5', '?limit=1&limit=2']) assert.equal((await exportPage(query)).status, 400, query);
  for (const cursor of ['not*a*cursor', 'bm90LWpzb24', encodeCursor({ i: -1 }), encodeCursor({ i: 1.5 }), encodeCursor({ i: '3' }), encodeCursor({ t: 'x' }), encodeCursor({ i: 1, t: 'x' })]) {
    const response = await exportPage(`?after=${cursor}`);
    assert.equal(response.status, 400, cursor);
    assert.deepEqual(JSON.parse(response.text), { error: 'Invalid audit export query' });
  }
});
