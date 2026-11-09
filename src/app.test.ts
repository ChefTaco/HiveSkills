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
