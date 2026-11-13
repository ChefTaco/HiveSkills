import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.HIVE_AUTO_MIGRATE = 'true';
process.env.HIVE_SKILLS_DATA_DIR = mkdtempSync(join(tmpdir(), 'hive-skills-app-test-'));
process.env.HIVE_SKILLS_SESSION_SECRET = 'app-test-session-secret-0123456789abcdef';
process.env.HIVE_SKILLS_ADMIN_USERS = 'admin';
process.env.HIVE_SKILLS_PUBLIC_URL = 'https://registry.test:4030';
process.env.HIVE_SKILLS_TARGETS = 'agent-1=deploy@agent-host.test';

await (await import('./upgrade.js')).skillsMigration([], true);
const { store } = await import('./db.js');
const app = (await import('./app.js')).default;

test('serves a Hermes-compatible public manifest', async () => {
  store.createSkill({ slug: 'hivemem', name: 'HiveMem', description: 'Memory integration', homepage: null, enabled: true });
  store.addRelease({ skillSlug: 'hivemem', version: '1.0.0', sha256: 'a'.repeat(64), archivePath: '/tmp/test-release.tgz', notes: null, createdAt: new Date().toISOString() });
  store.promoteRelease('hivemem', '1.0.0', 'stable');
  const response = await app.request('https://registry.test/v1/agent/manifest');
  assert.equal(response.status, 200);
  const body = await response.json() as { schemaVersion: number; skills: Array<{ slug: string; archiveUrl: string }> };
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.skills.length, 1);
  assert.equal(body.skills[0]?.slug, 'hivemem');
  assert.equal(body.skills[0]?.archiveUrl, 'https://registry.test:4030/v1/skills/hivemem/releases/1.0.0/archive');
});

test('protects administration with an OS session', async () => {
  const response = await app.request('https://registry.test/admin/skills');
  assert.equal(response.status, 401);
});


test('canary assignments do not advance stable, withdrawal and receipts are scoped', async () => {
  store.addRelease({ skillSlug: 'hivemem', version: '2.0.0', sha256: 'b'.repeat(64), archivePath: '/tmp/fixture2.tgz', notes: null, minHermesVersion: '1.5.0', maxHermesVersion: '2.4.0', createdAt: new Date().toISOString() });
  store.promoteRelease('hivemem', '2.0.0', 'canary');
  const token = store.enrollTarget('agent-1', 'canary', ['hivemem']);
  assert.equal((await app.request('https://registry.test/v1/agent/manifest?target=agent-1', { headers: { authorization: `Bearer ${token}` } })).status, 200);
  const response = await app.request('https://registry.test/v1/agent/manifest?target=agent-1&hermes_version=2.0.0', { headers: { authorization: `Bearer ${token}` } });
  const result = await response.json() as { skills: Array<{ version: string }> };
  assert.equal(result.skills[0]?.version, '2.0.0');
  const incompatible = await app.request('https://registry.test/v1/agent/manifest?target=agent-1&hermes_version=3.0.0', { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual((await incompatible.json() as { skills: unknown[] }).skills, []);
  assert.equal((await app.request('https://registry.test/v1/agent/manifest?target=agent-1&hermes_version=broken', { headers: { authorization: `Bearer ${token}` } })).status, 400);
  assert.equal(store.activeManifest()[0]?.release.version, '1.0.0');
  assert.equal((await app.request('https://registry.test/v1/agent/manifest?target=agent-1')).status, 401);
  store.withdrawRelease('hivemem', 'canary');
  assert.deepEqual(store.activeManifest('canary'), []);
  assert.equal(store.activeManifest().length, 1);
});

test('deployment targets come from configuration', async () => {
  assert.deepEqual(store.listTargets(), [{ name: 'agent-1', host: 'agent-host.test', username: 'deploy', enabled: true }]);
  const { parseTargets } = await import('./config.js');
  assert.deepEqual(parseTargets(undefined), []);
  assert.throws(() => parseTargets('agent-1=agent-host'), /name=user@host/);
});

test('public archives are limited to the release promoted on the requested channel', async () => {
  const archive = join(process.env.HIVE_SKILLS_DATA_DIR!, 'archive-fixture.tgz');
  writeFileSync(archive, 'fixture');
  store.createSkill({ slug: 'fixture', name: 'Fixture', description: 'Archive fixture', homepage: null, enabled: true });
  for (const version of ['1.0.0', '1.1.0', '2.0.0']) {
    store.addRelease({ skillSlug: 'fixture', version, sha256: 'c'.repeat(64), archivePath: archive, notes: null, createdAt: new Date().toISOString() });
  }
  const download = (version: string, query = '') => app.request(`https://registry.test/v1/skills/fixture/releases/${version}/archive${query}`);
  assert.equal((await download('1.0.0')).status, 404);
  store.promoteRelease('fixture', '1.0.0', 'stable');
  store.promoteRelease('fixture', '1.1.0', 'canary');
  assert.equal((await download('1.0.0')).status, 200);
  assert.equal((await download('1.1.0')).status, 404);
  assert.equal((await download('1.1.0', '?channel=canary')).status, 200);
  assert.equal((await download('1.0.0', '?channel=canary')).status, 404);
  assert.equal((await download('2.0.0')).status, 404);
  assert.equal((await download('1.0.0', '?channel=nightly')).status, 400);
  const detail = await (await app.request('https://registry.test/v1/skills/fixture')).json() as { release: { version: string } };
  assert.equal(detail.release.version, '1.0.0');
  store.withdrawRelease('fixture', 'canary');
  assert.equal((await download('1.1.0', '?channel=canary')).status, 404);

  const token = store.enrollTarget('agent-1', 'canary', ['fixture']);
  store.promoteRelease('fixture', '1.1.0', 'canary');
  const manifest = await (await app.request('https://registry.test/v1/agent/manifest?target=agent-1', { headers: { authorization: `Bearer ${token}` } })).json() as { channel: string; skills: Array<{ archiveUrl: string }> };
  assert.equal(manifest.channel, 'canary');
  assert.equal(manifest.skills[0]?.archiveUrl, 'https://registry.test:4030/v1/skills/fixture/releases/1.1.0/archive?channel=canary');
});

test('session secrets are required outside loopback development', async () => {
  const { resolveSessionSecret } = await import('./config.js');
  assert.throws(() => resolveSessionSecret({}, '0.0.0.0'), /must be configured/);
  assert.throws(() => resolveSessionSecret({ NODE_ENV: 'production' }, '127.0.0.1'), /must be configured/);
  assert.throws(() => resolveSessionSecret({ HIVE_SKILLS_SESSION_SECRET: 'short' }, '0.0.0.0'), /at least 32/);
  assert.equal(resolveSessionSecret({ HIVE_SKILLS_SESSION_SECRET: 'x'.repeat(32) }, '0.0.0.0'), 'x'.repeat(32));
  const first = resolveSessionSecret({}, '127.0.0.1');
  assert.equal(first.length >= 32, true);
  assert.notEqual(first, resolveSessionSecret({}, '127.0.0.1'));
});


test('owned browser request validation rejects malformed input before mutation',async()=>{
 const {createSession}=await import('./auth.js');
 const cookie='hive_skills_session='+createSession('admin');
 const before=store.getTarget('agent-1');
 const invalid=await app.request('https://registry.test/admin/targets/agent-1',{method:'PUT',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({host:'host;command',username:'deploy'})});
 assert.equal(invalid.status,400);assert.deepEqual(store.getTarget('agent-1'),before);
 const update=await app.request('https://registry.test/admin/skills/fixture',{method:'PATCH',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({enabled:'yes'})});
 assert.equal(update.status,400);
 const valid=await app.request('https://registry.test/admin/skills/fixture',{method:'PATCH',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({description:' Updated fixture '})});
 assert.equal(valid.status,200);assert.equal((await valid.json() as {description:string}).description,'Updated fixture');
});


test('catalog details explicitly report no promoted release for each channel', async () => {
  const slug = 'unpromoted-example';
  store.createSkill({ slug, name: 'Example', description: 'Synthetic catalog fixture', homepage: null, enabled: true });
  const detail = async (channel = 'stable') => {
    const response = await app.request(`https://registry.test/v1/skills/${slug}?channel=${channel}`);
    assert.equal(response.status, 200);
    return await response.json() as { release: { version: string } | null };
  };
  assert.equal((await detail()).release, null);
  store.addRelease({ skillSlug: slug, version: '1.0.0', sha256: 'e'.repeat(64), archivePath: '/tmp/synthetic-example.tgz', notes: null, createdAt: new Date().toISOString() });
  store.promoteRelease(slug, '1.0.0', 'canary');
  assert.equal((await detail()).release, null);
  assert.equal((await detail('canary')).release?.version, '1.0.0');
  store.withdrawRelease(slug, 'canary');
  assert.equal((await detail('canary')).release, null);
});

test('health endpoints keep legacy bodies and add suite-standard readiness', async () => {
  const live = await app.request('https://registry.test/health/live');
  assert.equal(live.status, 200);
  const liveBody = await live.json() as Record<string, unknown>;
  assert.equal(liveBody.status, 'ok');
  assert.equal(liveBody.service, 'hive-skills');
  assert.equal(liveBody.protocol, 1);
  const legacy = await app.request('https://registry.test/healthz');
  const legacyBody = await legacy.json() as Record<string, unknown>;
  assert.ok(['ok', 'degraded'].includes(String(legacyBody.status)));
  assert.equal(typeof legacyBody.missingArchives, 'number');
  const ready = await app.request('https://registry.test/health/ready');
  assert.equal(ready.status, legacy.status);
  assert.equal(ready.headers.get('cache-control'), 'no-store');
  const readyBody = await ready.json() as { status: string; service: string; checks: Record<string, { status: string; details?: { missingArchives?: number } }> };
  assert.equal(readyBody.service, 'hive-skills');
  assert.equal(readyBody.status, legacy.status === 200 ? 'ready' : 'not_ready');
  assert.equal(readyBody.checks.database?.details?.missingArchives, legacyBody.missingArchives);
});

test('requests carry an x-request-id without changing error bodies', async () => {
  const echoed = await app.request('https://registry.test/admin/skills', { headers: { 'x-request-id': 'fixture-request-1' } });
  assert.equal(echoed.status, 401);
  assert.equal(echoed.headers.get('x-request-id'), 'fixture-request-1');
  assert.deepEqual(await echoed.json(), { error: 'Sign in is required' });
  const correlated = await app.request('https://registry.test/healthz', { headers: { 'x-correlation-id': 'fixture-correlation-1' } });
  assert.equal(correlated.headers.get('x-request-id'), 'fixture-correlation-1');
  const generated = await app.request('https://registry.test/health/live');
  assert.match(generated.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
});

test('a body that is not JSON is a client error', async () => {
  const { createSession } = await import('./auth.js');
  const cookie = 'hive_skills_session=' + createSession('admin');
  const post = (path: string, method = 'POST') => app.request(`https://registry.test${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, body: '{"slug":' });
  for (const response of [await post('/auth/login'), await post('/admin/skills'), await post('/admin/targets/agent-1', 'PUT')]) {
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid JSON body' });
  }
});

test('logout revokes and audits only a session this registry issued', async () => {
  const { createSession, readAuth } = await import('./auth.js');
  const logout = (cookie: string) => app.request('https://registry.test/auth/logout', { method: 'POST', headers: { cookie } });
  const rows = () => store.listAudit(100, Number.MAX_SAFE_INTEGER) as Array<{ actor: string; action: string; subject: string }>;
  const before = rows().length;
  const token = createSession('admin');
  const [id] = token.split('.');
  // Unsigned or forged cookies neither write audit rows nor revoke the session they name.
  for (const cookie of ['hive_skills_session=injected-subject', `hive_skills_session=${id}`, `hive_skills_session=${id}.forged`]) {
    const response = await logout(cookie);
    assert.equal(response.status, 204);
    assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/);
  }
  assert.equal(rows().length, before);
  assert.equal(readAuth(`hive_skills_session=${token}`)?.username, 'admin');
  assert.equal((await logout(`hive_skills_session=${token}`)).status, 204);
  assert.equal(readAuth(`hive_skills_session=${token}`), undefined);
  const [latest] = rows();
  assert.deepEqual({ actor: latest?.actor, action: latest?.action, subject: latest?.subject }, { actor: 'admin', action: 'logout', subject: 'session' });
  // Replaying the revoked cookie is not audited again.
  await logout(`hive_skills_session=${token}`);
  assert.equal(rows().length, before + 1);
});

test('names no OS account can have do not exhaust the sign-in throttle', async () => {
  const login = (username: string) => app.request('https://registry.test/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'incorrect' }) });
  for (let index = 0; index < 1001; index++) assert.equal((await login(`no account ${index}`)).status, 401);
  // A well-formed name is still evaluated instead of being refused as throttled.
  assert.equal((await login('fixture-absent-account')).status, 401);
});

test('the public URL never ends with a slash, so archive links match what agents expect', async () => {
  const { publicUrlFrom } = await import('./config.js');
  assert.equal(publicUrlFrom('https://registry.test:4030/', 4030), 'https://registry.test:4030');
  assert.equal(publicUrlFrom('https://registry.test/skills//', 4030), 'https://registry.test/skills');
  assert.equal(publicUrlFrom('https://registry.test', 4030), 'https://registry.test');
  assert.equal(publicUrlFrom(undefined, 4031), 'https://localhost:4031');
});
