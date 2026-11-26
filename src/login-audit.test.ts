import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const temporary = mkdtempSync(join(tmpdir(), 'hive-skills-login-audit-test-'));
const deployScript = join(temporary, 'deploy-stub.sh');
writeFileSync(deployScript, '#!/bin/sh\nexit 0\n');
chmodSync(deployScript, 0o700);
process.env.HIVE_AUTO_MIGRATE = 'true';
process.env.HIVE_SKILLS_DATA_DIR = temporary;
process.env.HIVE_SKILLS_SESSION_SECRET = 'obviously-fake-login-audit-secret-0123456789';
process.env.HIVE_SKILLS_ADMIN_USERS = 'admin';
process.env.HIVE_SKILLS_PUBLIC_URL = 'https://skills.example.com';
process.env.HIVE_SKILLS_TARGETS = 'agent-1=deploy@agent-1.example.com';
process.env.HIVE_SKILLS_DEPLOY_SCRIPT = deployScript;
process.env.HIVE_SKILLS_TRUSTED_PROXIES = '192.0.2.10';

await (await import('./upgrade.js')).skillsMigration([], true);
const { store } = await import('./db.js');
const app = (await import('./app.js')).default;
const { auditExportPage } = await import('./audit-export.js');
const { createSession, readAuth } = await import('./auth.js');
const { DatabaseSync } = await import('./sqlite.js');
const throttle = await import('./login-throttle.js');
after(() => rmSync(temporary, { recursive: true, force: true }));

type Row = { actor: string; action: string; subject: string; details: string };
const auditRows = (): Row[] => store.listAudit(100, Number.MAX_SAFE_INTEGER) as Row[];
const login = (username: string, peer: string, headers: Record<string, string> = {}) => app.request('https://skills.example.com/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ username, password: 'obviously-wrong' }),
}, { incoming: { socket: { remoteAddress: peer } } });

test('a failed sign-in is audited with the throttle state and exported as a failure', async () => {
  const before = auditRows().length;
  assert.equal((await login('fixture-one', '198.51.100.1')).status, 401);
  const [failed] = auditRows();
  assert.equal(auditRows().length, before + 1);
  assert.deepEqual([failed?.actor, failed?.action, failed?.subject], ['fixture-one', 'login.failed', 'session']);
  const details = JSON.parse(failed!.details) as Record<string, unknown>;
  assert.deepEqual(details, { username: 'fixture-one', source: '198.51.100.1', throttled: false, accountDelaySeconds: 15, sourceFailures: 1 });
  assert.doesNotMatch(failed!.details, /obviously-wrong/);

  // The account delay answers 429 with Retry-After; only its first refusal is audited.
  const refused = await login('fixture-one', '198.51.100.1');
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) >= 1);
  assert.equal((await login('fixture-one', '198.51.100.1')).status, 429);
  const throttled = auditRows().filter((row) => row.action === 'login.failed' && JSON.parse(row.details).throttled === true);
  assert.equal(throttled.length, 1);
  assert.equal(JSON.parse(throttled[0]!.details).throttle, 'account');

  const rows = auditRows().filter((row) => row.action === 'login.failed').map((row, index) => ({ id: 10_000 + index, actor: row.actor, action: row.action, subject: row.subject, details: row.details, createdAt: new Date().toISOString(), magnusNodeId: null, agentRefs: [] }));
  const page = auditExportPage(rows, 100);
  assert.equal(page.data.length, rows.length);
  for (const record of page.data) {
    assert.equal(record.action, 'session.login_failed');
    assert.equal(record.outcome, 'failure');
    assert.deepEqual(record.target, { type: 'session' });
    assert.equal(record.actor.id, 'fixture-one');
  }
});

test('one source cannot cycle through accounts', async () => {
  for (let index = 0; index < throttle.SOURCE_MAX_FAILURES; index++) assert.equal((await login(`cycle-${index}`, '198.51.100.2')).status, 401);
  const blocked = await login('cycle-next', '198.51.100.2');
  assert.equal(blocked.status, 429);
  assert.equal(JSON.parse(auditRows()[0]!.details).throttle, 'source');
  // Other sources are unaffected.
  assert.equal((await login('cycle-next', '198.51.100.3')).status, 401);
});

test('behind a trusted proxy the forwarded client is the source', async () => {
  for (let index = 0; index < throttle.SOURCE_MAX_FAILURES; index++) {
    assert.equal((await login(`proxied-${index}`, '192.0.2.10', { 'x-forwarded-for': '203.0.113.7' })).status, 401);
  }
  assert.equal((await login('proxied-next', '192.0.2.10', { 'x-forwarded-for': '203.0.113.7' })).status, 429);
  // A different forwarded client through the same proxy is a different source.
  assert.equal((await login('proxied-next', '192.0.2.10', { 'x-forwarded-for': '203.0.113.8' })).status, 401);
  // An untrusted peer cannot choose its source with the header.
  assert.equal((await login('direct-one', '198.51.100.4', { 'x-forwarded-for': '203.0.113.9' })).status, 401);
  assert.equal(JSON.parse(auditRows()[0]!.details).source, '198.51.100.4');
});

test('client addresses honour only trusted proxies', () => {
  const trusted = throttle.parseTrustedProxies('192.0.2.10, ::ffff:192.0.2.11, 10.1.0.0/16');
  assert.equal(throttle.clientAddress('::ffff:198.51.100.1', undefined, trusted), '198.51.100.1');
  assert.equal(throttle.clientAddress('198.51.100.1', '203.0.113.1', trusted), '198.51.100.1');
  assert.equal(throttle.clientAddress('192.0.2.10', '203.0.113.1, 203.0.113.2', trusted), '203.0.113.2');
  assert.equal(throttle.clientAddress('192.0.2.10', '203.0.113.1, 192.0.2.11', trusted), '203.0.113.1');
  assert.equal(throttle.clientAddress('192.0.2.10', 'not-an-ip, 192.0.2.11', trusted), '192.0.2.11');
  assert.equal(throttle.clientAddress(undefined, '203.0.113.1', trusted), 'unknown');
  assert.throws(() => throttle.parseTrustedProxies('proxy.example.com'), /HIVE_SKILLS_TRUSTED_PROXIES/);
  assert.throws(() => throttle.parseTrustedProxies('10.0.0.0/33'), /HIVE_SKILLS_TRUSTED_PROXIES/);
  // CIDR ranges and presets.
  assert.equal(throttle.clientAddress('10.1.2.3', '203.0.113.1', trusted), '203.0.113.1');
  assert.equal(throttle.clientAddress('10.2.0.1', '203.0.113.1', trusted), '10.2.0.1');
  assert.equal(throttle.clientAddress('127.0.0.1', '203.0.113.1', throttle.parseTrustedProxies('loopback')), '203.0.113.1');
  // Proxies that append the client port: each client is still its own source.
  assert.equal(throttle.clientAddress('192.0.2.10', '203.0.113.5:51234', trusted), '203.0.113.5');
  assert.equal(throttle.clientAddress('192.0.2.10', '[2001:db8::1]:443', trusted), '2001:db8::1');
});

test('IPv6 clients are throttled by their /64', () => {
  assert.equal(throttle.sourceKey('2001:db8:1:2:aaaa::1'), throttle.sourceKey('2001:db8:1:2:bbbb::2'));
  assert.notEqual(throttle.sourceKey('2001:db8:1:2::1'), throttle.sourceKey('2001:db8:1:3::1'));
  assert.equal(throttle.sourceKey('203.0.113.5'), '203.0.113.5');
  assert.equal(throttle.sourceKey('unknown'), 'unknown');
});

test('a full account table forgets the oldest delay instead of refusing everyone', () => {
  let now = 1_000_000;
  const limiter = new throttle.LoginThrottle(() => now);
  for (let index = 0; index < throttle.MAX_ACCOUNTS; index++) limiter.failed(`flood-${index}`, `source-${index % 1000}`);
  // A legitimate account that never failed may still try.
  assert.equal(limiter.refusal('legitimate', 'source-legit'), undefined);
  limiter.failed('legitimate', 'source-legit');
  assert.equal(limiter.refusal('legitimate', 'source-legit')?.reason, 'account');
  // The oldest flood entry made room; the newest is still delayed.
  assert.equal(limiter.refusal('flood-0', 'source-legit'), undefined);
  assert.equal(limiter.refusal(`flood-${throttle.MAX_ACCOUNTS - 1}`, 'source-legit')?.reason, 'account');
  // A repeated failure moves the account to the back, so it is not the next to be forgotten.
  limiter.failed('flood-1', 'source-legit');
  limiter.failed('another', 'source-legit');
  assert.equal(limiter.refusal('flood-1', 'source-legit')?.reason, 'account');
  assert.equal(limiter.refusal('flood-2', 'source-legit'), undefined);
});

test('throttle delays and windows expire', () => {
  let now = 1_000_000;
  const limiter = new throttle.LoginThrottle(() => now);
  limiter.failed('fixture', 'source-a');
  assert.equal(limiter.refusal('fixture', 'source-a')?.reason, 'account');
  now += throttle.ACCOUNT_DELAY_MS;
  assert.equal(limiter.refusal('fixture', 'source-a'), undefined);
  for (let index = 1; index < throttle.SOURCE_MAX_FAILURES; index++) limiter.failed(`fixture-${index}`, 'source-a');
  assert.deepEqual(limiter.refusal('other', 'source-a'), { reason: 'source', retryAfterSeconds: (throttle.SOURCE_WINDOW_MS - throttle.ACCOUNT_DELAY_MS) / 1000, first: true });
  assert.equal(limiter.refusal('other', 'source-a')?.first, false);
  now = 1_000_000 + throttle.SOURCE_WINDOW_MS;
  assert.equal(limiter.refusal('other', 'source-a'), undefined);
});

test('sessions are stored by hash and older raw-id sessions are re-keyed', () => {
  const token = createSession('admin');
  const [id] = token.split('.') as [string];
  const db = new DatabaseSync(join(temporary, 'registry.sqlite'));
  try {
    assert.equal(db.prepare('SELECT 1 FROM sessions WHERE id=?').get(id), undefined);
    assert.equal(readAuth(`hive_skills_session=${token}`)?.username, 'admin');
    // A row written by an earlier release holds the raw id.
    const legacy = 'legacy-session-id-0123456789abcdefghijklmno';
    assert.equal(legacy.length, 43);
    const sign = (value: string) => `${value}.${createHmac('sha256', process.env.HIVE_SKILLS_SESSION_SECRET!).update(value).digest('base64url')}`;
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(legacy, 'admin', new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
    const signed = sign(legacy);
    assert.equal(readAuth(`hive_skills_session=${signed}`)?.username, 'admin');
    assert.equal(db.prepare('SELECT 1 FROM sessions WHERE id=?').get(legacy), undefined);
    const stored = createHash('sha256').update(legacy).digest('hex');
    assert.ok(db.prepare('SELECT 1 FROM sessions WHERE id=?').get(stored));
    assert.equal(readAuth(`hive_skills_session=${signed}`)?.username, 'admin');
    // The stored hash is never itself a session id, even in a correctly signed cookie.
    assert.equal(readAuth(`hive_skills_session=${sign(stored)}`), undefined);
    assert.ok(db.prepare('SELECT 1 FROM sessions WHERE id=?').get(stored), 'the row was not re-keyed');
    // Nor is a raw id in any other format.
    const odd = 'not-an-issued-session-id';
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(odd, 'admin', new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
    assert.equal(readAuth(`hive_skills_session=${sign(odd)}`), undefined);
  } finally { db.close(); }
});

test('the legacy SSH worker audits each job outcome', async () => {
  const { startDeploymentWorker } = await import('./deployment-worker.js');
  const done = store.createDeployment('agent-1', 'admin');
  const stop = startDeploymentWorker();
  try {
    for (let wait = 0; wait < 50 && !auditRows().some((row) => row.action === 'deployment.finished'); wait++) await new Promise((resolve) => setTimeout(resolve, 100));
    const finished = auditRows().find((row) => row.action === 'deployment.finished');
    assert.deepEqual([finished?.actor, finished?.subject], ['system', 'agent-1']);
    assert.deepEqual(JSON.parse(finished!.details), { id: done, status: 'completed', result: 'timer_installed' });
    const [record] = auditExportPage([{ id: 1, actor: 'system', action: 'deployment.finished', subject: 'agent-1', details: finished!.details, createdAt: new Date().toISOString(), magnusNodeId: null, agentRefs: [] }], 1).data;
    assert.deepEqual([record?.action, record?.outcome, record?.actor.type], ['deployment.complete', 'success', 'system']);
    const [failed] = auditExportPage([{ id: 2, actor: 'system', action: 'deployment.finished', subject: 'agent-1', details: JSON.stringify({ id: 'x', status: 'failed', result: 'exit_1' }), createdAt: new Date().toISOString(), magnusNodeId: null, agentRefs: [] }], 1).data;
    assert.equal(failed?.outcome, 'failure');
  } finally { await stop(); }
});
