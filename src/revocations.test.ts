import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { keygen, signRelease, signRevocations } from '../scripts/sign-release.mjs';
import { parsePublisherKeys } from '../scripts/archive-utils.mjs';
import { verifyTransparencyLog, type LogRow, type LogHead } from '../scripts/transparency-log.mjs';

const temporary = mkdtempSync(join(tmpdir(), 'hive-skills-revocations-test-'));
after(() => rmSync(temporary, { recursive: true, force: true }));
const publisherFile = join(temporary, 'publisher.pem'), secondFile = join(temporary, 'second.pem'), unpinnedFile = join(temporary, 'unpinned.pem');
const authorityFile = join(temporary, 'authority.pem');
const publisher = keygen({ out: publisherFile, keyId: 'publisher-2026' });
const second = keygen({ out: secondFile, keyId: 'publisher-2027' });
keygen({ out: unpinnedFile, keyId: 'unpinned' });
const authority = keygen({ out: authorityFile, keyId: 'revocations-2026' });

process.env.HIVE_AUTO_MIGRATE = 'true';
process.env.HIVE_SKILLS_DATA_DIR = temporary;
process.env.HIVE_SKILLS_SESSION_SECRET = 'obviously-fake-revocation-session-secret-0123456789';
process.env.HIVE_SKILLS_ADMIN_USERS = 'admin';
process.env.HIVE_SKILLS_PUBLIC_URL = 'https://skills.example.com';
process.env.HIVE_SKILLS_PUBLISHER_KEYS = JSON.stringify([publisher, second]);
process.env.HIVE_SKILLS_REVOCATION_KEYS = JSON.stringify([authority]);

await (await import('./upgrade.js')).skillsMigration([], true);
const { store } = await import('./db.js');
const { createSession } = await import('./auth.js');
const app = (await import('./app.js')).default;
const admin = { cookie: `hive_skills_session=${createSession('admin')}` };
const viewer = { cookie: `hive_skills_session=${createSession('viewer')}` };
const url = (path: string) => `https://skills.example.com${path}`;
const json = (method: string, body: unknown, headers: Record<string, string> = admin) => ({ method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });

const sha = (label: string) => createHash('sha256').update(label).digest('hex');
/** A release stored the way an upload stores it, with an optional verified signature. */
function release(slug: string, version: string, key?: { file: string; keyId: string }) {
  if (!store.getSkill(slug)) store.createSkill({ slug, name: slug, description: 'Synthetic fixture', homepage: null, enabled: true });
  const archivePath = join(temporary, `${slug}-${version}.tgz`);
  writeFileSync(archivePath, `${slug}@${version}`);
  const digest = sha(`${slug}@${version}`);
  const signature = key ? { keyId: key.keyId, value: signRelease({ key: key.file, keyId: key.keyId, slug, version, sha256: digest }).signature } : null;
  store.addRelease({ skillSlug: slug, version, sha256: digest, archivePath, notes: null, createdAt: new Date().toISOString() }, signature);
  return digest;
}
const list = (sequence: number, extra: Record<string, unknown> = {}, key = authorityFile) => signRevocations({ key, keyId: 'revocations-2026', list: { sequence, keys: [], releases: [], ...extra } });
const publish = (body: unknown) => app.request(url('/admin/revocations'), json('PUT', body));

store.saveTarget({ name: 'agent-1', host: 'agent.example.com', username: 'hermes', enabled: true });
const targetToken = store.enrollTarget('agent-1', 'stable', null);
const asTarget = { authorization: `Bearer ${targetToken}` };

test('a revocation list is accepted only when a pinned revocation key signed it, with a growing sequence', async () => {
  assert.equal((await app.request(url('/v1/revocations'), { headers: admin })).status, 404);
  // Signed by a publisher key, not the revocation authority.
  const foreign = signRevocations({ key: publisherFile, keyId: 'revocations-2026', list: { sequence: 1, keys: [], releases: [] } });
  assert.equal((await publish(foreign)).status, 400);
  assert.equal((await publish({ ...list(1), signature: { keyId: 'publisher-2026', value: list(1).signature.value } })).status, 400);
  const altered = list(1);
  assert.equal((await publish({ ...altered, payload: altered.payload.replace('"sequence":1', '"sequence":2') })).status, 400);
  assert.equal((await publish({ payload: 'not json', signature: altered.signature })).status, 400);
  assert.equal((await publish({ ...list(1), extra: true })).status, 400);
  assert.equal((await app.request(url('/admin/revocations'), json('PUT', list(1), viewer))).status, 403);
  assert.equal((await app.request(url('/admin/revocations'), json('PUT', list(1), {}))).status, 401);
  const expired = signRevocations({ key: authorityFile, keyId: 'revocations-2026', list: { sequence: 1, issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z', keys: [], releases: [] } });
  assert.equal((await publish(expired)).status, 400);

  const first = list(1);
  const created = await publish(first);
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { sequence: 1, keys: 0, releases: 0, withdrawn: [] });
  assert.equal((await publish(first)).status, 409, 'the same sequence again');
  assert.equal((await publish(list(1, { releases: [] }))).status, 409);

  // Readers: an enrolled target or an administrator, never anonymous.
  assert.equal((await app.request(url('/v1/revocations'))).status, 401);
  assert.equal((await app.request(url('/v1/revocations?target=agent-1'), { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await app.request(url('/v1/revocations'), { headers: viewer })).status, 403);
  const served = await (await app.request(url('/v1/revocations?target=agent-1'), { headers: asTarget })).json() as { payload: string; signature: unknown; sequence: number; payloadSha256: string };
  assert.equal(served.payload, first.payload, 'served exactly as signed');
  assert.deepEqual(served.signature, first.signature);
  assert.equal(served.payloadSha256, createHash('sha256').update(first.payload).digest('hex'));
  const audit = (store.listAudit(1, Number.MAX_SAFE_INTEGER) as Array<{ action: string; subject: string; actor: string }>)[0];
  assert.deepEqual([audit?.action, audit?.subject, audit?.actor], ['revocations.publish', '1', 'admin']);
});

test('revoking a release withdraws it from its channels and blocks promotion and re-upload', async () => {
  const digest = release('incident', '1.0.0', { file: publisherFile, keyId: 'publisher-2026' });
  release('incident', '1.1.0', { file: publisherFile, keyId: 'publisher-2026' });
  store.promoteRelease('incident', '1.0.0', 'stable');
  store.promoteRelease('incident', '1.0.0', 'canary');
  const response = await publish(list(2, { releases: [{ slug: 'incident', version: '1.0.0', sha256: digest, reason: 'Synthetic incident' }] }));
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json() as { withdrawn: Array<{ channel: string }> }).withdrawn.sort((a, b) => a.channel.localeCompare(b.channel)), [{ slug: 'incident', version: '1.0.0', channel: 'canary' }, { slug: 'incident', version: '1.0.0', channel: 'stable' }]);
  assert.equal(store.channelRelease('stable', 'incident'), undefined);
  assert.equal(store.channelRelease('canary', 'incident'), undefined);
  const manifest = await (await app.request(url('/v1/agent/manifest'))).json() as { skills: Array<{ slug: string }> };
  assert.equal(manifest.skills.some((skill) => skill.slug === 'incident'), false);
  const promote = await app.request(url('/admin/channels/stable/incident'), json('PUT', { version: '1.0.0' }));
  assert.equal(promote.status, 409);
  assert.match(JSON.stringify(await promote.json()), /revoked release cannot be promoted/);
  assert.equal((await app.request(url('/admin/channels/stable/incident'), json('PUT', { version: '1.1.0' }))).status, 200);
  // The withdrawals are audited as automatic and appear in the event feed.
  const withdrawals = (store.listAudit(20, Number.MAX_SAFE_INTEGER) as Array<{ action: string; actor: string; details: string }>).filter((row) => row.action === 'release.withdraw');
  assert.equal(withdrawals.length, 2);
  assert.ok(withdrawals.every((row) => row.actor === 'system' && JSON.parse(row.details).automatic === 'revoked'));
  const events = await (await app.request(url('/v1/hive/events?limit=200'), { headers: admin })).json() as { data: Array<{ title: string }> };
  assert.ok(events.data.some((event) => event.title === 'Skill incident 1.0.0 revoked and withdrawn from stable'));
  // Deleting the skill and uploading the revoked version again is refused.
  store.deleteSkill('incident');
  store.createSkill({ slug: 'incident', name: 'incident', description: 'Synthetic fixture', homepage: null, enabled: true });
  const reupload = await app.request(url('/admin/skills/incident/releases'), json('POST', { version: '1.0.0', archiveBase64: Buffer.from('x').toString('base64') }));
  assert.equal(reupload.status, 409);
  assert.match(JSON.stringify(await reupload.json()), /version is revoked/);
});

test('a revoked publisher key can no longer sign releases here', async () => {
  release('rotated', '1.0.0');
  assert.equal((await publish(list(3, { keys: [{ keyId: 'publisher-2026', publicKey: publisher.publicKey, reason: 'Synthetic key compromise' }] }))).status, 201);
  const digest = store.getRelease('rotated', '1.0.0')!.sha256;
  const attach = (file: string, keyId: string) => app.request(url('/admin/skills/rotated/releases/1.0.0/signature'), json('PUT', { keyId, value: signRelease({ key: file, keyId, slug: 'rotated', version: '1.0.0', sha256: digest }).signature }));
  const refused = await attach(publisherFile, 'publisher-2026');
  assert.equal(refused.status, 400);
  assert.match(JSON.stringify(await refused.json()), /publisher key is revoked/);
  assert.equal((await attach(secondFile, 'publisher-2027')).status, 200);
});

test('the signature overview reports every release status, the keys, the revocations and the log head', async () => {
  release('overview', '1.0.0', { file: secondFile, keyId: 'publisher-2027' });
  release('overview', '1.1.0');
  // Stored outside an upload: a signature by a key this registry does not pin, and one that does not verify.
  release('overview', '1.2.0');
  store.setReleaseSignature('overview', '1.2.0', { keyId: 'unpinned', value: signRelease({ key: unpinnedFile, keyId: 'unpinned', slug: 'overview', version: '1.2.0', sha256: sha('overview@1.2.0') }).signature });
  release('overview', '1.3.0');
  store.setReleaseSignature('overview', '1.3.0', { keyId: 'publisher-2027', value: signRelease({ key: unpinnedFile, keyId: 'publisher-2027', slug: 'overview', version: '1.3.0', sha256: sha('overview@1.3.0') }).signature });
  assert.equal((await app.request(url('/admin/signatures'))).status, 401);
  assert.equal((await app.request(url('/admin/signatures'), { headers: viewer })).status, 403);
  assert.equal((await app.request(url('/admin/signatures?target=agent-1'), { headers: asTarget })).status, 401, 'targets cannot read the admin overview');
  const response = await app.request(url('/admin/signatures'), { headers: admin });
  assert.equal(response.status, 200);
  const overview = await response.json() as {
    publisherKeys: Array<{ keyId: string; revocation: unknown }>; revocationKeys: Array<{ keyId: string }>;
    revocations: { sequence: number; keys: unknown[]; releases: unknown[] }; releases: Array<{ slug: string; version: string; status: string }>; log: { size: number };
  };
  const status = (slug: string, version: string) => overview.releases.find((entry) => entry.slug === slug && entry.version === version)?.status;
  assert.equal(status('overview', '1.0.0'), 'verified');
  assert.equal(status('overview', '1.1.0'), 'unsigned');
  assert.equal(status('overview', '1.2.0'), 'unknown_key');
  assert.equal(status('overview', '1.3.0'), 'invalid');
  assert.equal(status('incident', '1.1.0'), undefined, 'deleted with its skill');
  assert.equal(status('rotated', '1.0.0'), 'verified', 're-signed with the new key');
  release('signed-old', '1.0.0');
  assert.deepEqual(overview.publisherKeys.map((key) => [key.keyId, key.revocation !== null]), [['publisher-2026', true], ['publisher-2027', false]]);
  assert.deepEqual(overview.revocationKeys.map((key) => key.keyId), ['revocations-2026']);
  assert.deepEqual([overview.revocations.sequence, overview.revocations.keys.length, overview.revocations.releases.length], [3, 1, 0]);
  assert.equal(overview.log.size, (store.transparencyHead()).size - 1, 'one more release since the read');
});

test('a release signed only by a key revoked later shows as revoked_key; a revoked release as revoked', async () => {
  const digest = release('keyed', '1.0.0', { file: secondFile, keyId: 'publisher-2027' });
  release('keyed', '2.0.0', { file: secondFile, keyId: 'publisher-2027' });
  assert.equal((await publish(list(4, {
    keys: [{ keyId: 'publisher-2026', publicKey: publisher.publicKey, reason: 'Synthetic key compromise' }, { keyId: 'publisher-2027', publicKey: second.publicKey, reason: 'Synthetic second compromise' }],
    releases: [{ slug: 'keyed', version: '1.0.0', sha256: digest, reason: 'Synthetic incident' }],
  }))).status, 201);
  const overview = await (await app.request(url('/admin/signatures'), { headers: admin })).json() as { releases: Array<{ slug: string; version: string; status: string }> };
  const status = (version: string) => overview.releases.find((entry) => entry.slug === 'keyed' && entry.version === version)?.status;
  assert.deepEqual([status('1.0.0'), status('2.0.0')], ['revoked', 'revoked_key']);
});

test('receipts may report revoked releases the bridge refused or quarantined', async () => {
  const send = (body: unknown) => app.request(url('/v1/agent/receipts/agent-1'), { method: 'POST', headers: { ...asTarget, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const revocations = [{ slug: 'keyed', version: '1.0.0', reason: 'release', action: 'refused' }, { slug: 'keyed', version: '2.0.0', reason: 'key', keyId: 'publisher-2027', action: 'quarantined' }];
  assert.equal((await send({ status: 'revoked', skills: {}, changed: [], revocations })).status, 200);
  const stored = JSON.parse((store.listReceipts('agent-1') as Array<{ receipt_json: string }>)[0]!.receipt_json) as { status: string; revocations: unknown };
  assert.deepEqual([stored.status, stored.revocations], ['revoked', revocations]);
  for (const bad of [[{ slug: 'keyed', version: '1.0.0', reason: 'other', action: 'refused' }], [{ slug: 'keyed', version: '1.0.0', reason: 'release', action: 'refused', extra: 1 }], 'nope']) {
    assert.equal((await send({ status: 'revoked', skills: {}, revocations: bad })).status, 400, JSON.stringify(bad));
  }
});

test('the audit export maps revocation publications', async () => {
  const page = await (await app.request(url('/v1/audit/export?limit=200'), { headers: admin })).json() as { data: Array<{ action: string; target?: { type?: string; id?: string } }> };
  const record = page.data.find((entry) => entry.action === 'revocations.publish');
  assert.deepEqual(record?.target, { type: 'revocation_list', id: '1' });
});

test('every revocation list and release is in the transparency log, verifiable end to end', async () => {
  const head = await (await app.request(url('/v1/transparency/head?target=agent-1'), { headers: asTarget })).json() as LogHead;
  const entries: LogRow[] = [];
  for (let from = 0; entries.length < head.size;) {
    const page = await (await app.request(url(`/v1/transparency/entries?target=agent-1&from=${from}&limit=3`), { headers: asTarget })).json() as { entries: LogRow[]; nextFrom: number | null };
    entries.push(...page.entries);
    if (page.nextFrom === null) break;
    from = page.nextFrom;
  }
  const summary = verifyTransparencyLog({ entries, head, logKeys: head.logKey.publicKey, revocationKeys: parsePublisherKeys(JSON.stringify([authority])) });
  assert.equal(summary.revocationLists, 4);
  assert.equal(summary.revocationSequence, 4);
  assert.ok(summary.releases >= 10);
  // With the publisher keys, the invalid signature this test stored directly (bypassing the upload
  // check) is found; the registry itself never accepts one.
  assert.throws(() => verifyTransparencyLog({ entries, head, logKeys: head.logKey.publicKey, publisherKeys: parsePublisherKeys(JSON.stringify([publisher, second])) }), /publisher signature of overview@1\.3\.0 does not verify/);
  const kinds = entries.map((row) => (JSON.parse(row.entry) as { kind: string }).kind);
  assert.ok(kinds.includes('release.signed'));
  assert.ok(kinds.includes('revocations.published'));
});
