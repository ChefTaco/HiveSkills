import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { keygen, signRelease } from '../scripts/sign-release.mjs';
import { parsePublisherKeys, verifyReleaseSignature } from '../scripts/archive-utils.mjs';

const temporary = mkdtempSync(join(tmpdir(), 'hive-skills-signed-test-'));
after(() => rmSync(temporary, { recursive: true, force: true }));
const keyFile = join(temporary, 'publisher.pem');
const otherKeyFile = join(temporary, 'other.pem');
const pinned = keygen({ out: keyFile, keyId: 'example-2026' });
const other = keygen({ out: otherKeyFile, keyId: 'other-2026' });

process.env.HIVE_AUTO_MIGRATE = 'true';
process.env.HIVE_SKILLS_DATA_DIR = temporary;
process.env.HIVE_SKILLS_SESSION_SECRET = 'obviously-fake-signed-session-secret-0123456789';
process.env.HIVE_SKILLS_ADMIN_USERS = 'admin';
process.env.HIVE_SKILLS_PUBLIC_URL = 'https://skills.example.com';
process.env.HIVE_SKILLS_PUBLISHER_KEYS = JSON.stringify([pinned]);
process.env.HIVE_SKILLS_REQUIRE_SIGNED_RELEASES = 'true';

await (await import('./upgrade.js')).skillsMigration([], true);
const { store } = await import('./db.js');
const { createSession } = await import('./auth.js');
const app = (await import('./app.js')).default;
const admin = { cookie: `hive_skills_session=${createSession('admin')}` };

function archive(label: string): Buffer {
  const source = join(temporary, `source-${label}`);
  mkdirSync(source);
  writeFileSync(join(source, 'SKILL.md'), `# ${label}\n`);
  const file = join(temporary, `${label}.tgz`);
  assert.equal(spawnSync('tar', ['-czf', file, '-C', source, '.']).status, 0);
  return readFileSync(file);
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const upload = (body: Record<string, unknown>) => app.request('https://skills.example.com/admin/skills/signed-example/releases', {
  method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
store.createSkill({ slug: 'signed-example', name: 'Signed example', description: 'Synthetic fixture', homepage: null, enabled: true });

test('signatures cover exactly one slug, version and digest', () => {
  const keys = parsePublisherKeys(JSON.stringify([pinned]));
  const release = { slug: 'signed-example', version: '1.0.0', sha256: 'a'.repeat(64) };
  const signed = signRelease({ key: keyFile, keyId: 'example-2026', ...release });
  const signature = { keyId: signed.keyId, value: signed.signature };
  assert.equal(verifyReleaseSignature(keys, release, signature), true);
  for (const changed of [{ ...release, slug: 'other-example' }, { ...release, version: '1.0.1' }, { ...release, sha256: 'b'.repeat(64) }]) {
    assert.equal(verifyReleaseSignature(keys, changed, signature), false);
  }
  const foreign = signRelease({ key: otherKeyFile, keyId: 'example-2026', ...release });
  assert.equal(verifyReleaseSignature(keys, release, { keyId: 'example-2026', value: foreign.signature }), false);
  assert.equal(verifyReleaseSignature(keys, release, { keyId: 'other-2026', value: foreign.signature }), false);
  for (const invalid of [null, {}, { keyId: 'example-2026' }, { keyId: 'example-2026', value: 'not base64url!' }, { keyId: 'example-2026', value: 'AAAA' }]) {
    assert.equal(verifyReleaseSignature(keys, release, invalid), false);
  }
  assert.equal(parsePublisherKeys(undefined).size, 0);
  assert.equal(parsePublisherKeys('').size, 0);
  for (const bad of ['{', '{}', JSON.stringify([{ keyId: 'x' }]), JSON.stringify([{ keyId: 'bad id', publicKey: pinned.publicKey }]), JSON.stringify([{ keyId: 'x', publicKey: 'AAAA' }]), JSON.stringify([pinned, pinned])]) {
    assert.throws(() => parsePublisherKeys(bad), Error, bad);
  }
});

test('a registry that requires signatures refuses unsigned, foreign and mismatched uploads', async () => {
  const bytes = archive('one');
  const fields = { version: '1.0.0', archiveBase64: bytes.toString('base64') };
  const unsigned = await upload(fields);
  assert.equal(unsigned.status, 400);
  assert.match(JSON.stringify(await unsigned.json()), /only publisher-signed releases/);
  const foreign = signRelease({ key: otherKeyFile, keyId: 'other-2026', slug: 'signed-example', version: '1.0.0', sha256: sha(bytes) });
  assert.equal((await upload({ ...fields, signatureKeyId: 'other-2026', signature: foreign.signature })).status, 400);
  const wrongVersion = signRelease({ key: keyFile, keyId: 'example-2026', slug: 'signed-example', version: '9.9.9', sha256: sha(bytes) });
  assert.equal((await upload({ ...fields, signatureKeyId: 'example-2026', signature: wrongVersion.signature })).status, 400);
  assert.equal((await upload({ ...fields, signature: wrongVersion.signature })).status, 400);
  assert.equal(store.getRelease('signed-example', '1.0.0'), undefined, 'nothing was stored');
  const valid = signRelease({ key: keyFile, keyId: 'example-2026', slug: 'signed-example', version: '1.0.0', archive: join(temporary, 'one.tgz') });
  const created = await upload({ ...fields, signatureKeyId: valid.keyId, signature: valid.signature });
  assert.equal(created.status, 201);
  assert.deepEqual((await created.json() as { signature: unknown }).signature, { keyId: 'example-2026', value: valid.signature });
  const metadata = await (await app.request('https://skills.example.com/v1/skills/signed-example/releases/1.0.0', { headers: admin })).json() as { signature: unknown };
  assert.deepEqual(metadata.signature, { keyId: 'example-2026', value: valid.signature });
  const listed = await (await app.request('https://skills.example.com/admin/skills/signed-example/releases', { headers: admin })).json() as Array<{ signature: unknown }>;
  assert.deepEqual(listed[0]?.signature, { keyId: 'example-2026', value: valid.signature });
});

test('a raw archive upload carries its signature in the query string', async () => {
  const bytes = archive('raw');
  const signed = signRelease({ key: keyFile, keyId: 'example-2026', slug: 'signed-example', version: '1.1.0', sha256: sha(bytes) });
  const response = await app.request(`https://skills.example.com/admin/skills/signed-example/releases?version=1.1.0&signatureKeyId=example-2026&signature=${signed.signature}`, {
    method: 'POST', headers: { ...admin, 'content-type': 'application/gzip' }, body: new Uint8Array(bytes),
  });
  assert.equal(response.status, 201);
});

test('an existing release can be signed later without changing it', async () => {
  const bytes = Buffer.from('seeded without a signature');
  const archivePath = join(temporary, 'seeded.tgz');
  writeFileSync(archivePath, bytes);
  store.addRelease({ skillSlug: 'signed-example', version: '0.9.0', sha256: sha(bytes), archivePath, notes: null, createdAt: new Date().toISOString() });
  const attach = (body: unknown) => app.request('https://skills.example.com/admin/skills/signed-example/releases/0.9.0/signature', { method: 'PUT', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const wrong = signRelease({ key: keyFile, keyId: 'example-2026', slug: 'signed-example', version: '0.9.0', sha256: 'c'.repeat(64) });
  assert.equal((await attach({ keyId: 'example-2026', value: wrong.signature })).status, 400);
  const right = signRelease({ key: keyFile, keyId: 'example-2026', slug: 'signed-example', version: '0.9.0', sha256: sha(bytes) });
  assert.equal((await attach({ keyId: 'example-2026', value: right.signature })).status, 200);
  assert.deepEqual(store.releaseSignature('signed-example', '0.9.0'), { keyId: 'example-2026', value: right.signature });
  assert.equal(store.getRelease('signed-example', '0.9.0')?.sha256, sha(bytes));
  const audit = (store.listAudit(1, Number.MAX_SAFE_INTEGER) as Array<{ action: string; subject: string }>)[0];
  assert.deepEqual([audit?.action, audit?.subject], ['release.sign', 'signed-example@0.9.0']);
  assert.equal((await app.request('https://skills.example.com/admin/skills/signed-example/releases/9.9.9/signature', { method: 'PUT', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ keyId: 'example-2026', value: right.signature }) })).status, 404);
});
