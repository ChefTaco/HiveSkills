import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync as PriorDatabase } from 'node:sqlite';

process.env.HIVE_AUTO_MIGRATE = 'true';
process.env.HIVE_SKILLS_DATA_DIR = mkdtempSync(join(tmpdir(), 'hive-skills-agent-links-test-'));
process.env.HIVE_SKILLS_SESSION_SECRET = 'agent-links-test-secret-0123456789abcdef';
process.env.HIVE_SKILLS_ADMIN_USERS = 'admin';
process.env.HIVE_SKILLS_PUBLIC_URL = 'https://registry.test:4030';
process.env.HIVE_SKILLS_TARGETS = 'agent-1=deploy@agent-host.test,agent-2=deploy@other-host.test';

const { DatabaseSync } = await import('./sqlite.js');
const { initializeSchema: releasedBaseline } = await import('./migrations/managed-format-1.js');
const { initializeDeploymentJournal } = await import('./migrations/managed-format-2.js');
const { initializeSchema } = await import('./schema.js');
await (await import('./upgrade.js')).skillsMigration([], true);
const { store } = await import('./db.js');
const app = (await import('./app.js')).default;
const { createSession } = await import('./auth.js');
const cookie = 'hive_skills_session=' + createSession('admin');
const url = 'https://registry.test';
const legacyTargets = [
  { name: 'agent-1', host: 'agent-host.test', username: 'deploy', enabled: true },
  { name: 'agent-2', host: 'other-host.test', username: 'deploy', enabled: true },
];
const get = async (path: string) => {
  const response = await app.request(url + path, { headers: { cookie } });
  return { status: response.status, body: await response.json() as unknown };
};
const put = async (target: string, body: Record<string, unknown>) => {
  const response = await app.request(`${url}/admin/targets/${target}`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as unknown };
};
const base = { host: 'agent-host.test', username: 'deploy' };

test('managed-format-3 adds target agent links without changing released target rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'skills-agent-links-fixture-'));
  try {
    const file = join(directory, 'registry.sqlite');
    const prior = new PriorDatabase(file);
    releasedBaseline(prior);
    initializeDeploymentJournal(prior);
    prior.prepare('INSERT INTO deployment_targets VALUES (?,?,?,?)').run('legacy-target', 'legacy.test', 'deploy', 1);
    prior.close();
    const db = new DatabaseSync(file);
    try {
      initializeSchema(db);
      initializeSchema(db);
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='target_agent_links'").get());
      assert.deepEqual({ ...db.prepare('SELECT * FROM deployment_targets').get() }, { name: 'legacy-target', host: 'legacy.test', username: 'deploy', enabled: 1 });
      assert.equal(db.prepare('SELECT count(*) AS count FROM target_agent_links').get().count, 0);
      // Older binaries keep their positional four-column target writes.
      db.prepare('INSERT INTO deployment_targets VALUES (?,?,?,?)').run('older-binary', 'older.test', 'deploy', 1);
      assert.throws(() => db.prepare("INSERT INTO target_agent_links VALUES ('missing-target','node-a','[]','fixture')").run());
    } finally { db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the release manifest pins the managed-format-3 checksum', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { hiveRelease: { migrations: Array<{ component: string; id: string; checksum: string }> } };
  const entry = pkg.hiveRelease.migrations.find((m) => m.component === 'skills' && m.id === 'managed-format-3');
  const source = readFileSync(new URL('../src/migrations/managed-format-3.ts', import.meta.url));
  assert.equal(entry?.checksum, createHash('sha256').update(source).digest('hex'));
});

test('unbound targets and unfiltered listings keep the legacy response', async () => {
  assert.deepEqual(await get('/admin/targets'), { status: 200, body: legacyTargets });
  assert.deepEqual(await put('agent-1', base), { status: 200, body: { ok: true } });
  assert.deepEqual(await get('/admin/targets'), { status: 200, body: legacyTargets });
  assert.deepEqual(await get('/admin/targets?nodeId=node-a'), { status: 200, body: [] });
});

test('targets store a deduplicated Magnus binding and filter by exact node id', async () => {
  assert.deepEqual(await put('agent-1', { ...base, magnusNodeId: 'node-a', agentRefs: ['node-a~default', 'node-a~coder', 'node-a~default'] }), { status: 200, body: { ok: true } });
  const bound = { ...legacyTargets[0], magnusNodeId: 'node-a', agentRefs: ['node-a~default', 'node-a~coder'] };
  assert.deepEqual(await get('/admin/targets'), { status: 200, body: [bound, legacyTargets[1]] });
  assert.deepEqual(await get('/admin/targets?nodeId=node-a'), { status: 200, body: [bound] });
  assert.deepEqual(await get('/admin/targets?nodeId=node'), { status: 200, body: [] });
  // Older clients that omit the fleet fields cannot erase the binding.
  assert.deepEqual(await put('agent-1', { ...base, enabled: true }), { status: 200, body: { ok: true } });
  assert.deepEqual(await get('/admin/targets?nodeId=node-a'), { status: 200, body: [bound] });
  // Changing only the agent list keeps the node; a node without agents is listed without agentRefs.
  assert.equal((await put('agent-1', { ...base, agentRefs: [] })).status, 200);
  assert.deepEqual(await get('/admin/targets?nodeId=node-a'), { status: 200, body: [{ ...legacyTargets[0], magnusNodeId: 'node-a' }] });
  assert.equal((await put('agent-1', { ...base, magnusNodeId: null })).status, 200);
  assert.deepEqual(await get('/admin/targets'), { status: 200, body: legacyTargets });
});

test('invalid bindings and filters are rejected with the existing error format', async () => {
  assert.equal((await put('agent-2', { host: 'other-host.test', username: 'deploy', magnusNodeId: 'node-b', agentRefs: ['node-b~ops'] })).status, 200);
  const before = await get('/admin/targets');
  const invalid = [
    { magnusNodeId: 'node b' },
    { magnusNodeId: '' },
    { magnusNodeId: 'n'.repeat(129) },
    { magnusNodeId: 'node-b', agentRefs: ['node-b'] },
    { magnusNodeId: 'node-b', agentRefs: ['node-b~ops~extra'] },
    { magnusNodeId: 'node-b', agentRefs: ['node-b~'] },
    { magnusNodeId: 'node-b', agentRefs: 'node-b~ops' },
    { magnusNodeId: 'node-b', agentRefs: Array.from({ length: 65 }, (_, index) => `node-b~p${index}`) },
  ];
  for (const fields of invalid) assert.deepEqual(await put('agent-2', { host: 'other-host.test', username: 'deploy', ...fields }), { status: 400, body: { error: 'Invalid registry request' } });
  for (const fields of [{ agentRefs: ['node-c~ops'] }, { magnusNodeId: 'node-c' }, { magnusNodeId: null, agentRefs: ['node-b~ops'] }]) {
    assert.deepEqual(await put('agent-2', { host: 'other-host.test', username: 'deploy', ...fields }), { status: 400, body: { error: 'Invalid target' } });
  }
  assert.deepEqual(await get('/admin/targets'), before);
  assert.equal((await put('agent-2', { host: 'other-host.test', username: 'deploy', magnusNodeId: 'node-b', agentRefs: Array.from({ length: 64 }, (_, index) => `node-b~p${index}`) })).status, 200);
  for (const query of ['nodeId=', 'nodeId=bad%20node', 'nodeId=a~b']) assert.deepEqual(await get(`/admin/targets?${query}`), { status: 400, body: { error: 'Invalid target filter' } });
  for (const query of ['targetId=', 'targetId=Agent_1']) assert.deepEqual(await get(`/admin/receipts?${query}`), { status: 400, body: { error: 'Invalid receipt filter' } });
});

test('receipts can be filtered by target while the unfiltered listing is unchanged', async () => {
  store.enrollTarget('agent-1', 'stable', null);
  store.enrollTarget('agent-2', 'canary', null);
  store.recordReceipt('agent-2', { status: 'activated', skills: {} });
  const all = await get('/admin/receipts');
  assert.equal(all.status, 200);
  const rows = all.body as Array<{ target: string; receipt_json: string | null }>;
  assert.deepEqual(rows.map((row) => row.target).sort(), ['agent-1', 'agent-2']);
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['channel', 'receipt_json', 'skills_json', 'target', 'updated_at']);
  assert.deepEqual(await get('/admin/receipts?targetId=agent-2'), { status: 200, body: rows.filter((row) => row.target === 'agent-2') });
  assert.deepEqual(await get('/admin/receipts?targetId=unknown-target'), { status: 200, body: [] });
});
