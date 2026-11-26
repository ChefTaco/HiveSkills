import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const temporary = mkdtempSync(join(tmpdir(), 'hive-skills-pinned-test-'));
process.env.HIVE_AUTO_MIGRATE = 'true';
process.env.HIVE_SKILLS_DATA_DIR = temporary;
process.env.HIVE_SKILLS_SESSION_SECRET = 'obviously-fake-pinned-session-secret-0123456789';
process.env.HIVE_SKILLS_ADMIN_USERS = 'admin';
process.env.HIVE_SKILLS_PUBLIC_URL = 'https://skills.example.com';
process.env.HIVE_SKILLS_TARGETS = 'agent-1=deploy@agent-1.example.com,agent-2=deploy@agent-2.example.com';

await (await import('./upgrade.js')).skillsMigration([], true);
const { store } = await import('./db.js');
const { createSession } = await import('./auth.js');
const app = (await import('./app.js')).default;
after(() => rmSync(temporary, { recursive: true, force: true }));

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const archives: Record<string, Buffer> = {};
const release = (slug: string, version: string, extra: { minHermesVersion?: string; maxHermesVersion?: string } = {}) => {
  const bytes = Buffer.from(`synthetic ${slug} ${version} archive`);
  const archivePath = join(temporary, `${slug}-${version}.tgz`);
  writeFileSync(archivePath, bytes);
  archives[`${slug}@${version}`] = bytes;
  store.addRelease({ skillSlug: slug, version, sha256: digest(bytes), archivePath, notes: `notes ${version}`, minHermesVersion: extra.minHermesVersion ?? null, maxHermesVersion: extra.maxHermesVersion ?? null, createdAt: new Date().toISOString() });
  return archivePath;
};

store.createSkill({ slug: 'pinned-example', name: 'Pinned example', description: 'Synthetic pinned fixture', homepage: null, enabled: true });
store.createSkill({ slug: 'other-example', name: 'Other example', description: 'Synthetic fixture', homepage: null, enabled: true });
release('pinned-example', '1.0.0', { minHermesVersion: '1.0.0', maxHermesVersion: '2.0.0' });
release('pinned-example', '1.1.0');
const corrupt = release('pinned-example', '1.2.0');
writeFileSync(corrupt, 'tampered bytes');
release('other-example', '1.0.0');
store.promoteRelease('pinned-example', '1.1.0', 'stable');
store.promoteRelease('pinned-example', '1.1.0', 'canary');
store.promoteRelease('other-example', '1.0.0', 'stable');

const admin = { cookie: `hive_skills_session=${createSession('admin')}` };
const member = { cookie: `hive_skills_session=${createSession('member')}` };
const scopedToken = store.enrollTarget('agent-1', 'stable', ['pinned-example']);
const openToken = store.enrollTarget('agent-2', 'canary', null);
const asTarget = (target: string, token: string) => ({ query: `?target=${target}`, headers: { authorization: `Bearer ${token}` } });

const metadata = (version: string, query = '', headers: Record<string, string> = {}) =>
  app.request(`https://skills.example.com/v1/skills/pinned-example/releases/${version}${query}`, { headers });
const archive = (version: string, query = '', headers: Record<string, string> = {}, slug = 'pinned-example') =>
  app.request(`https://skills.example.com/v1/skills/${slug}/releases/${version}/archive${query}`, { headers });

test('release metadata reports any immutable version with its digest, size, compatibility and channels', async () => {
  const promoted = await metadata('1.1.0', '', admin);
  assert.equal(promoted.status, 200);
  assert.equal(promoted.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await promoted.json(), {
    slug: 'pinned-example',
    version: '1.1.0',
    sha256: digest(archives['pinned-example@1.1.0']!),
    size: archives['pinned-example@1.1.0']!.length,
    notes: 'notes 1.1.0',
    compatibility: { minHermesVersion: null, maxHermesVersion: null },
    channels: ['canary', 'stable'],
    archiveUrl: 'https://skills.example.com/v1/skills/pinned-example/releases/1.1.0/archive',
    createdAt: store.getRelease('pinned-example', '1.1.0')!.createdAt,
    advisory: null,
  });
  const older = await metadata('1.0.0', asTarget('agent-1', scopedToken).query, asTarget('agent-1', scopedToken).headers);
  assert.equal(older.status, 200);
  const body = await older.json() as { sha256: string; channels: string[]; compatibility: unknown };
  assert.equal(body.sha256, digest(archives['pinned-example@1.0.0']!));
  assert.deepEqual(body.channels, []);
  assert.deepEqual(body.compatibility, { minHermesVersion: '1.0.0', maxHermesVersion: '2.0.0' });
  assert.equal((await metadata('9.9.9', '', admin)).status, 404);
  assert.equal((await metadata('not-a-version', '', admin)).status, 404);
});

test('release metadata requires a pinned-release reader', async () => {
  assert.equal((await metadata('1.1.0')).status, 401);
  assert.equal((await metadata('1.0.0', '', member)).status, 403);
  assert.equal((await metadata('1.0.0', '', { authorization: 'Bearer fake-identity-token' })).status, 401);
  assert.equal((await metadata('1.0.0', '?target=agent-1', { authorization: 'Bearer fake-wrong-token' })).status, 401);
  assert.equal((await metadata('1.0.0', '?target=agent-1')).status, 401);
  assert.equal((await metadata('1.0.0', '?target=agent-9', { authorization: `Bearer ${scopedToken}` })).status, 401);
  // A token enrolled for one target does not authenticate another.
  assert.equal((await metadata('1.0.0', '?target=agent-2', { authorization: `Bearer ${scopedToken}` })).status, 401);
  // A target limited to some skills cannot read another skill's releases, even to learn it is missing.
  const other = await app.request(`https://skills.example.com/v1/skills/other-example/releases/1.0.0?target=agent-1`, { headers: { authorization: `Bearer ${scopedToken}` } });
  assert.equal(other.status, 403);
  const open = await app.request(`https://skills.example.com/v1/skills/other-example/releases/1.0.0?target=agent-2`, { headers: { authorization: `Bearer ${openToken}` } });
  assert.equal(open.status, 200);
});

test('the archive of a non-promoted release is served to pinned-release readers with its digest header', async () => {
  for (const [query, headers] of [['', admin], [asTarget('agent-1', scopedToken).query, asTarget('agent-1', scopedToken).headers], [asTarget('agent-2', openToken).query, asTarget('agent-2', openToken).headers]] as const) {
    const response = await archive('1.0.0', query, headers);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/gzip');
    assert.equal(response.headers.get('content-disposition'), 'attachment; filename="pinned-example-1.0.0.tgz"');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, archives['pinned-example@1.0.0']);
    assert.equal(response.headers.get('x-content-sha256'), digest(bytes));
    assert.equal(response.headers.get('x-content-sha256'), store.getRelease('pinned-example', '1.0.0')!.sha256);
  }
  assert.equal((await archive('9.9.9', '', admin)).status, 404);
});

test('the promoted archive stays public and carries the same digest header', async () => {
  for (const query of ['', '?channel=canary']) {
    const response = await archive('1.1.0', query);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/gzip');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, archives['pinned-example@1.1.0']);
    assert.equal(response.headers.get('x-content-sha256'), digest(bytes));
  }
  const pinned = await archive('1.1.0', asTarget('agent-1', scopedToken).query, asTarget('agent-1', scopedToken).headers);
  assert.equal(pinned.headers.get('x-content-sha256'), digest(archives['pinned-example@1.1.0']!));
});

test('anonymous and unauthorized callers cannot download a non-promoted release', async () => {
  // Anonymous callers still see a non-promoted release as missing, as before pinned releases.
  assert.equal((await archive('1.0.0')).status, 404);
  assert.equal((await archive('1.0.0', '?channel=canary')).status, 404);
  assert.equal((await archive('9.9.9')).status, 404);
  assert.equal((await archive('1.0.0', '', member)).status, 403);
  assert.equal((await archive('1.0.0', '', { authorization: 'Bearer fake-identity-token' })).status, 401);
  assert.equal((await archive('1.0.0', '?target=agent-1', { authorization: 'Bearer fake-wrong-token' })).status, 401);
  assert.equal((await archive('1.0.0', '?target=agent-1')).status, 401);
  assert.equal((await archive('1.0.0', '?target=agent-2', { authorization: `Bearer ${scopedToken}` })).status, 401);
  // Refused before the release is looked up, so a scoped target learns nothing about other skills.
  store.addRelease({ ...store.getRelease('other-example', '1.0.0')!, version: '0.9.0' });
  assert.equal((await archive('0.9.0', '?target=agent-1', { authorization: `Bearer ${scopedToken}` }, 'other-example')).status, 403);
  assert.equal((await archive('0.9.0', '?target=agent-2', { authorization: `Bearer ${openToken}` }, 'other-example')).status, 200);
});

test('a stored archive that no longer matches its digest is refused', async () => {
  const response = await archive('1.2.0', '', admin);
  assert.equal(response.status, 500);
  assert.equal(response.headers.get('x-content-sha256'), null);
  const failed = await response.json() as { error: { code: string; message: string } };
  assert.deepEqual([failed.error.code, failed.error.message], ['archive_digest_mismatch', 'Release archive failed its digest check']);
  // The metadata keeps reporting the immutable digest that was published.
  const body = await (await metadata('1.2.0', '', admin)).json() as { sha256: string };
  assert.equal(body.sha256, digest(archives['pinned-example@1.2.0']!));
});

test('releases of a disabled skill are neither described nor served', async () => {
  store.updateSkill('other-example', { enabled: false });
  try {
    assert.equal((await app.request('https://skills.example.com/v1/skills/other-example/releases/1.0.0', { headers: admin })).status, 404);
    assert.equal((await archive('1.0.0', '', admin, 'other-example')).status, 404);
    assert.equal((await archive('1.0.0', '', {}, 'other-example')).status, 404);
  } finally {
    store.updateSkill('other-example', { enabled: true });
  }
});

test('advisories warn pinned readers without changing the immutable release', async () => {
  const advise = (version: string, body: unknown, headers: Record<string, string> = admin) => app.request(`https://skills.example.com/admin/skills/pinned-example/releases/${version}/advisory`, {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const clear = (version: string) => app.request(`https://skills.example.com/admin/skills/pinned-example/releases/${version}/advisory`, { method: 'DELETE', headers: admin });
  assert.equal((await advise('1.0.0', { level: 'deprecated', reason: 'Superseded' }, member)).status, 403);
  assert.equal((await advise('9.9.9', { level: 'deprecated', reason: 'Superseded' })).status, 404);
  for (const invalid of [{ level: 'broken', reason: 'x' }, { level: 'yanked' }, { level: 'yanked', reason: '' }, { level: 'yanked', reason: 'x', extra: 1 }]) {
    assert.equal((await advise('1.0.0', invalid)).status, 400, JSON.stringify(invalid));
  }
  const before = store.getRelease('pinned-example', '1.0.0');
  const set = await advise('1.0.0', { level: 'yanked', reason: 'Breaks the memory tool' });
  assert.equal(set.status, 200);
  const notice = await set.json() as { level: string; reason: string; since: string };
  assert.deepEqual([notice.level, notice.reason], ['yanked', 'Breaks the memory tool']);
  assert.deepEqual(store.getRelease('pinned-example', '1.0.0'), before, 'the release row is unchanged');
  // Pinned readers (targets and administrators) see the notice; the archive is still served, flagged.
  const pinned = await (await metadata('1.0.0', asTarget('agent-1', scopedToken).query, asTarget('agent-1', scopedToken).headers)).json() as { advisory: unknown; sha256: string };
  assert.deepEqual(pinned.advisory, notice);
  const download = await archive('1.0.0', asTarget('agent-1', scopedToken).query, asTarget('agent-1', scopedToken).headers);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('x-release-advisory'), 'yanked');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), archives['pinned-example@1.0.0']);
  const listed = await (await app.request('https://skills.example.com/admin/skills/pinned-example/releases', { headers: admin })).json() as Array<{ version: string; advisory: unknown }>;
  assert.deepEqual(listed.find((release) => release.version === '1.0.0')?.advisory, notice);
  assert.equal(listed.find((release) => release.version === '1.1.0')?.advisory, null);
  // A yanked release cannot be promoted; a deprecated one can.
  const promote = (version: string) => app.request('https://skills.example.com/admin/channels/canary/pinned-example', { method: 'PUT', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ version }) });
  assert.equal((await promote('1.0.0')).status, 409);
  assert.equal((await advise('1.0.0', { level: 'deprecated', reason: 'Use 1.1.0' })).status, 200);
  assert.equal((await promote('1.0.0')).status, 200);
  assert.equal((await promote('1.1.0')).status, 200);
  const audit = (store.listAudit(10, Number.MAX_SAFE_INTEGER) as Array<{ action: string; subject: string }>).filter((row) => row.action.startsWith('release.advisory'));
  assert.deepEqual(audit.map((row) => row.subject), ['pinned-example@1.0.0', 'pinned-example@1.0.0']);
  assert.equal((await clear('1.0.0')).status, 204);
  assert.equal((await clear('1.0.0')).status, 404);
  assert.equal((await (await metadata('1.0.0', '', admin)).json() as { advisory: unknown }).advisory, null);
  assert.equal((await archive('1.0.0', '', admin)).headers.get('x-release-advisory'), null);
});
