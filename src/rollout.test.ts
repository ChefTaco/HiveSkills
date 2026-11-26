import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const temporary = mkdtempSync(join(tmpdir(), 'hive-skills-rollout-test-'));
process.env.HIVE_AUTO_MIGRATE = 'true';
process.env.HIVE_SKILLS_DATA_DIR = temporary;
process.env.HIVE_SKILLS_SESSION_SECRET = 'obviously-fake-rollout-session-secret-0123456789';
process.env.HIVE_SKILLS_ADMIN_USERS = 'admin';
process.env.HIVE_SKILLS_PUBLIC_URL = 'https://skills.example.com';
process.env.HIVE_SKILLS_TARGETS = 'agent-1=deploy@agent-1.example.com,agent-2=deploy@agent-2.example.com,agent-3=deploy@agent-3.example.com';
process.env.HIVE_SKILLS_CANARY_PROMOTE_AFTER = '2';
process.env.HIVE_SKILLS_CANARY_AUTO_ROLLBACK = 'true';
after(() => rmSync(temporary, { recursive: true, force: true }));

await (await import('./upgrade.js')).skillsMigration([], true);
const { store } = await import('./db.js');
const app = (await import('./app.js')).default;
const { createSession } = await import('./auth.js');
const { parseRolloutPolicyEnv } = await import('./rollout-policy.js');

const release = (slug: string, version: string, fill: string) => {
  store.addRelease({ skillSlug: slug, version, sha256: fill.repeat(64), archivePath: `/tmp/${slug}-${version}.tgz`, notes: null, createdAt: new Date().toISOString() });
  return { version, sha256: fill.repeat(64) };
};
const tokens: Record<string, string> = {};
const receipt = (target: string, status: string, skills: Record<string, { version: string; sha256: string }>) => app.request(`https://skills.example.com/v1/agent/receipts/${target}`, {
  method: 'POST', headers: { authorization: `Bearer ${tokens[target]}`, 'content-type': 'application/json' }, body: JSON.stringify({ status, skills }),
});
const versions = (slug: string) => ({ stable: store.channelRelease('stable', slug)?.version, canary: store.channelRelease('canary', slug)?.version });
const systemAudit = () => (store.listAudit(100, Number.MAX_SAFE_INTEGER) as Array<{ actor: string; action: string; subject: string; details: string }>).filter((row) => row.actor === 'system');

tokens['agent-1'] = store.enrollTarget('agent-1', 'canary', null);
tokens['agent-2'] = store.enrollTarget('agent-2', 'canary', null);
tokens['agent-3'] = store.enrollTarget('agent-3', 'stable', null);

test('the policy settings are validated', () => {
  assert.deepEqual(parseRolloutPolicyEnv({}), { promoteAfter: null, autoRollback: false });
  assert.deepEqual(parseRolloutPolicyEnv({ HIVE_SKILLS_CANARY_PROMOTE_AFTER: '3', HIVE_SKILLS_CANARY_AUTO_ROLLBACK: 'true' }), { promoteAfter: 3, autoRollback: true });
  for (const value of ['0', '-1', '1.5', 'many', '1001']) assert.throws(() => parseRolloutPolicyEnv({ HIVE_SKILLS_CANARY_PROMOTE_AFTER: value }));
  assert.throws(() => parseRolloutPolicyEnv({ HIVE_SKILLS_CANARY_AUTO_ROLLBACK: 'yes' }));
});

test('a canary release is promoted to stable after enough distinct healthy canary targets', async () => {
  store.createSkill({ slug: 'promote-example', name: 'Promote example', description: 'Synthetic fixture', homepage: null, enabled: true });
  const stable = release('promote-example', '1.0.0', 'a');
  const canary = release('promote-example', '1.1.0', 'b');
  store.promoteRelease('promote-example', stable.version, 'stable');
  store.promoteRelease('promote-example', canary.version, 'canary');
  // A stable target and repeated receipts from one canary target do not count.
  assert.equal((await receipt('agent-3', 'activated', { 'promote-example': canary })).status, 200);
  await receipt('agent-1', 'activated', { 'promote-example': canary });
  await receipt('agent-1', 'activated', { 'promote-example': canary });
  // A different digest under the same version is not the canary release.
  await receipt('agent-2', 'activated', { 'promote-example': { ...canary, sha256: 'f'.repeat(64) } });
  assert.deepEqual(versions('promote-example'), { stable: '1.0.0', canary: '1.1.0' });
  await receipt('agent-2', 'activated', { 'promote-example': canary });
  assert.deepEqual(versions('promote-example'), { stable: '1.1.0', canary: '1.1.0' });
  const [promoted] = systemAudit();
  assert.equal(promoted?.action, 'release.promote');
  assert.deepEqual(JSON.parse(promoted!.details), { channel: 'stable', version: '1.1.0', automatic: 'canary_healthy', healthyTargets: 2 });
  // The HiveEvent feed reports it.
  const admin = { cookie: `hive_skills_session=${createSession('admin')}` };
  const feed = await (await app.request('https://skills.example.com/v1/hive/events', { headers: admin })).json() as { data: Array<{ type: string; title: string; summary: string }> };
  const event = feed.data.find((item) => item.type === 'skill.release.promoted' && item.title.includes('automatically'));
  assert.match(event?.summary ?? '', /2 canary targets reported it healthy/);
});

test('an advised canary release is never promoted automatically', async () => {
  store.createSkill({ slug: 'advised-example', name: 'Advised example', description: 'Synthetic fixture', homepage: null, enabled: true });
  const canary = release('advised-example', '2.0.0', 'c');
  store.promoteRelease('advised-example', canary.version, 'canary');
  store.setReleaseAdvisory('advised-example', canary.version, 'deprecated', 'Do not ship', 'admin');
  await receipt('agent-1', 'activated', { 'advised-example': canary });
  await receipt('agent-2', 'activated', { 'advised-example': canary });
  assert.equal(versions('advised-example').stable, undefined);
});

test('a failed restart with the canary release rolls canary back to stable', async () => {
  store.createSkill({ slug: 'rollback-example', name: 'Rollback example', description: 'Synthetic fixture', homepage: null, enabled: true });
  const stable = release('rollback-example', '1.0.0', 'd');
  const canary = release('rollback-example', '1.1.0', 'e');
  store.promoteRelease('rollback-example', stable.version, 'stable');
  store.promoteRelease('rollback-example', canary.version, 'canary');
  // A failure with the stable release installed is not the canary's fault.
  await receipt('agent-1', 'restart_failed', { 'rollback-example': stable });
  assert.deepEqual(versions('rollback-example'), { stable: '1.0.0', canary: '1.1.0' });
  await receipt('agent-1', 'restart_failed', { 'rollback-example': canary });
  assert.deepEqual(versions('rollback-example'), { stable: '1.0.0', canary: '1.0.0' });
  const [rolledBack] = systemAudit();
  assert.deepEqual(JSON.parse(rolledBack!.details), { channel: 'canary', version: '1.0.0', automatic: 'rollback', failedVersion: '1.1.0', target: 'agent-1' });
});

test('without a stable release a failing canary release is withdrawn', async () => {
  store.createSkill({ slug: 'new-example', name: 'New example', description: 'Synthetic fixture', homepage: null, enabled: true });
  const canary = release('new-example', '0.1.0', '9');
  store.promoteRelease('new-example', canary.version, 'canary');
  await receipt('agent-2', 'restart_failed', { 'new-example': canary });
  assert.deepEqual(versions('new-example'), { stable: undefined, canary: undefined });
  const [withdrawn] = systemAudit();
  assert.deepEqual([withdrawn?.action, withdrawn?.subject], ['release.withdraw', 'new-example']);
  const admin = { cookie: `hive_skills_session=${createSession('admin')}` };
  const feed = await (await app.request('https://skills.example.com/v1/hive/events', { headers: admin })).json() as { data: Array<{ type: string; title: string }> };
  assert.ok(feed.data.some((item) => item.type === 'skill.release.withdrawn' && item.title === 'Skill new-example withdrawn from canary automatically'));
});
