import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateHiveEvent, type HiveEvent } from '@hivemagnus/hive-common/contracts';

process.env.HIVE_AUTO_MIGRATE = 'true';
process.env.HIVE_SKILLS_DATA_DIR = mkdtempSync(join(tmpdir(), 'hive-skills-events-test-'));
process.env.HIVE_SKILLS_SESSION_SECRET = 'events-test-secret-0123456789abcdef';
process.env.HIVE_SKILLS_ADMIN_USERS = 'admin';
process.env.HIVE_SKILLS_PUBLIC_URL = 'https://registry.test:4030';
process.env.HIVE_SKILLS_TARGETS = 'agent-1=deploy@agent-host.test,agent-2=deploy@other-host.test';

await (await import('./upgrade.js')).skillsMigration([], true);
const { config } = await import('./config.js');
const { DatabaseSync } = await import('./sqlite.js');
const { store } = await import('./db.js');
const app = (await import('./app.js')).default;
const { createSession } = await import('./auth.js');
const { hiveEventPage, decodePosition, encodePosition, RETENTION_MS } = await import('./hive-events.js');
const { HiveEventPage } = await import('./browser-contracts.js');

const admin = 'hive_skills_session=' + createSession('admin');
const reader = 'hive_skills_session=' + createSession('reader');
const url = 'https://registry.test';
const db = new DatabaseSync(config.databasePath);
const now = Date.now();
const at = (offsetMs: number) => new Date(now - offsetMs).toISOString();
const hour = 60 * 60 * 1000;

const job = (id: string, target: string, status: string, result: string | null, updated: string) =>
  db.prepare('INSERT INTO deployment_jobs VALUES (?,?,?,?,?,?,?)').run(id, target, 'admin', status, result, updated, updated);
const audit = (action: string, subject: string, details: Record<string, unknown>, created: string) =>
  db.prepare('INSERT INTO audit_log (actor, action, subject, details, created_at) VALUES (?,?,?,?,?)').run('admin', action, subject, JSON.stringify(details), created);

const feed = async (query = '', cookie = admin) => {
  const response = await app.request(`${url}/v1/hive/events${query}`, { headers: { cookie } });
  return { status: response.status, body: await response.json() as { data: HiveEvent[]; nextCursor: string | null } };
};
const all = async () => (await feed('?limit=200')).body.data;

test('seed records and fleet links', async () => {
  const bind = await app.request(`${url}/admin/targets/agent-1`, { method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ host: 'agent-host.test', username: 'deploy', magnusNodeId: 'node-a', agentRefs: ['node-a~ops'] }) });
  assert.equal(bind.status, 200);
  job('00000000-0000-4000-8000-000000000001', 'agent-1', 'failed', 'executor said: secret-ish output', at(2 * hour));
  job('00000000-0000-4000-8000-000000000002', 'agent-2', 'completed', 'ok', at(1 * hour));
  job('00000000-0000-4000-8000-000000000003', 'agent-2', 'failed', 'Approval expired before dispatch', at(3 * hour));
  job('00000000-0000-4000-8000-000000000004', 'agent-1', 'unknown', null, at(30 * 60 * 1000));
  job('00000000-0000-4000-8000-000000000005', 'agent-2', 'awaiting_approval', null, at(10 * 60 * 1000));
  job('00000000-0000-4000-8000-000000000006', 'agent-2', 'failed', null, at(15 * 24 * hour));
  audit('release.create', 'fixture@1.2.0', { sha256: 'a'.repeat(64) }, at(5 * hour));
  audit('release.promote', 'fixture', { channel: 'stable', version: '1.2.0' }, at(4 * hour));
  audit('release.withdraw', 'fixture', { channel: 'canary' }, at(90 * 60 * 1000));
  audit('skill.delete', 'retired', {}, at(80 * 60 * 1000));
  audit('login', 'session', {}, at(70 * 60 * 1000));
  audit('release.promote', 'fixture', { channel: 'stable', version: '1.0.0' }, at(20 * 24 * hour));
  const token = store.enrollTarget('agent-2', 'stable', null);
  const receipt = await app.request(`${url}/v1/agent/receipts/agent-2`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'restart_failed', skills: {} }) });
  assert.equal(receipt.status, 200);
  const healthy = store.enrollTarget('agent-1', 'stable', null);
  assert.equal((await app.request(`${url}/v1/agent/receipts/agent-1`, { method: 'POST', headers: { authorization: `Bearer ${healthy}`, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'activated', skills: {} }) })).status, 200);
});

test('requires a session and registry administrator access, like the receipt reads', async () => {
  assert.equal((await feed('', '')).status, 401);
  assert.equal((await app.request(`${url}/v1/hive/events`, { headers: { authorization: 'Bearer not-a-token' } })).status, 401);
  const forbidden = await feed('', reader);
  assert.equal(forbidden.status, 403);
  assert.equal((await app.request(`${url}/admin/receipts`, { headers: { cookie: reader } })).status, 403);
});

test('maps records to strictly valid events with severities, fleet subjects and HiveXUI links', async () => {
  const { status, body } = await feed('?limit=200');
  assert.equal(status, 200);
  assert.equal(HiveEventPage.safeParse(body).success, true);
  for (const event of body.data) {
    assert.equal(validateHiveEvent(event, { strict: true }).ok, true, event.id);
    assert.deepEqual(event.link, { product: 'hiveskills', path: '/?page=skills' });
    assert.equal(event.product, 'hiveskills');
  }
  const byType = Object.fromEntries(body.data.map((event) => [event.type, event]));
  assert.deepEqual(body.data.map((event) => event.type), [
    'skill.release.published', 'skill.release.promoted', 'deployment.expired', 'deployment.failed', 'skill.release.withdrawn',
    'skill.deleted', 'deployment.succeeded', 'deployment.unknown', 'target.restart.failed',
  ]);
  assert.equal(byType['deployment.failed']?.severity, 'critical');
  assert.deepEqual(byType['deployment.failed']?.subject, { nodeId: 'node-a', agentRef: 'node-a~ops' });
  assert.equal(byType['deployment.failed']?.id, 'hiveskills:deployment:00000000-0000-4000-8000-000000000001:failed');
  assert.equal(byType['deployment.failed']?.sourceRef, '00000000-0000-4000-8000-000000000001');
  assert.doesNotMatch(JSON.stringify(body), /secret-ish/);
  assert.equal(byType['deployment.unknown']?.severity, 'warning');
  assert.equal(byType['deployment.expired']?.severity, 'info');
  assert.equal(byType['deployment.succeeded']?.severity, 'info');
  assert.equal(byType['deployment.succeeded']?.subject, undefined);
  assert.equal(byType['target.restart.failed']?.severity, 'warning');
  assert.equal(byType['skill.release.withdrawn']?.severity, 'warning');
  assert.equal(byType['skill.release.promoted']?.title, 'Skill fixture 1.2.0 promoted to stable');
  assert.equal(byType['skill.release.published']?.title, 'Skill fixture 1.2.0 published');
});

test('pages oldest first and the cursor round-trips without gaps or repeats', async () => {
  const expected = await all();
  const seen: HiveEvent[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 20; pages++) {
    const { status, body } = await feed(`?limit=2${cursor ? `&after=${cursor}` : ''}`);
    assert.equal(status, 200);
    assert.ok(body.data.length <= 2);
    seen.push(...body.data);
    if (!body.nextCursor) break;
    const position = decodePosition(body.nextCursor);
    assert.deepEqual(position, { occurredAt: body.data.at(-1)!.occurredAt, id: body.data.at(-1)!.id });
    assert.equal(encodePosition(position!), body.nextCursor);
    cursor = body.nextCursor;
  }
  assert.deepEqual(seen.map((event) => event.id), expected.map((event) => event.id));
  const sorted = [...seen].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  assert.deepEqual(seen, sorted);
  // A caught-up client asking after the last event gets an empty page and a null cursor.
  const last = expected.at(-1)!;
  assert.deepEqual((await feed(`?after=${encodePosition(last)}`)).body, { data: [], nextCursor: null });
});

test('event IDs are stable for the same record', async () => {
  assert.deepEqual((await all()).map((event) => event.id), (await all()).map((event) => event.id));
  const record = { id: 'job-1', target: 'agent-1', status: 'failed', result: null, updatedAt: at(hour), magnusNodeId: null, agentRefs: [] };
  const first = hiveEventPage({ deployments: [record], audit: [], receipts: [] }, undefined, 10, now).data[0];
  const second = hiveEventPage({ deployments: [{ ...record }], audit: [], receipts: [] }, undefined, 10, now + hour).data[0];
  assert.equal(first?.id, 'hiveskills:deployment:job-1:failed');
  assert.deepEqual(first, second);
});

test('serves only the last 14 days, even for an older cursor', async () => {
  job('00000000-0000-4000-8000-000000000007', 'agent-2', 'completed', null, at(RETENTION_MS - 60_000));
  job('00000000-0000-4000-8000-000000000008', 'agent-2', 'completed', null, at(RETENTION_MS + 60_000));
  const ids = (await all()).map((event) => event.id);
  assert.ok(ids.includes('hiveskills:deployment:00000000-0000-4000-8000-000000000007:completed'));
  assert.ok(!ids.includes('hiveskills:deployment:00000000-0000-4000-8000-000000000008:completed'));
  assert.ok(!ids.includes('hiveskills:deployment:00000000-0000-4000-8000-000000000006:failed'));
  const old = encodePosition({ occurredAt: at(30 * 24 * hour), id: 'hiveskills:old' });
  assert.deepEqual((await feed(`?limit=200&after=${old}`)).body.data.map((event) => event.id), ids);
});

test('rejects malformed limits and cursors with 400', async () => {
  for (const query of ['?limit=0', '?limit=-1', '?limit=abc', '?limit=1.5', '?after=%25%25', '?after=bm90LWpzb24', `?after=${Buffer.from('{"t":"yesterday","i":"x"}').toString('base64url')}`, `?after=${Buffer.from('{"t":"2026-01-01T00:00:00.000Z"}').toString('base64url')}`, '?limit=1&limit=2']) {
    const response = await feed(query);
    assert.equal(response.status, 400, query);
  }
  const capped = await feed('?limit=500');
  assert.equal(capped.status, 200);
  assert.equal((await feed('?limit=1')).body.data.length, 1);
  assert.equal((await feed('')).status, 200);
});

test('drops events that fail validation without breaking the page', () => {
  let dropped = 0;
  const good = { id: 'job-ok', target: 'agent-1', status: 'completed', result: null, updatedAt: at(hour), magnusNodeId: null, agentRefs: [] };
  const bad = { ...good, id: 'job-bad', target: 'agent\u0007bell' };
  const page = hiveEventPage({ deployments: [good, bad], audit: [], receipts: [] }, undefined, 10, now, (count) => { dropped += count; });
  assert.equal(dropped, 1);
  assert.deepEqual(page.data.map((event) => event.id), ['hiveskills:deployment:job-ok:completed']);
  // A fleet link the event contract cannot carry is left off rather than dropping the event.
  const loose = hiveEventPage({ deployments: [{ ...good, magnusNodeId: 'Node.A', agentRefs: ['Node.A~ops'] }], audit: [], receipts: [] }, undefined, 10, now);
  assert.equal(loose.data[0]?.subject, undefined);
});
