import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, mock } from 'node:test';

const temporary = mkdtempSync(join(tmpdir(), 'hive-skills-limits-test-'));
process.env.HIVE_AUTO_MIGRATE = 'true';
process.env.HIVE_SKILLS_DATA_DIR = temporary;
process.env.HIVE_SKILLS_SESSION_SECRET = 'obviously-fake-limits-session-secret-0123456789';
process.env.HIVE_SKILLS_ADMIN_USERS = 'admin';
process.env.HIVE_SKILLS_PUBLIC_URL = 'https://skills.example.com';
process.env.HIVE_SKILLS_TARGETS = 'agent-1=deploy@agent-1.example.com';

await (await import('./upgrade.js')).skillsMigration([], true);
const { store } = await import('./db.js');
const { createSession } = await import('./auth.js');
const appModule = await import('./app.js');
const app = appModule.default;
after(() => rmSync(temporary, { recursive: true, force: true }));

const admin = `hive_skills_session=${createSession('admin')}`;
const url = (path: string) => `https://skills.example.com${path}`;

/** A request whose body arrives in chunks, with no Content-Length. */
function chunked(path: string, bytes: number, headers: Record<string, string> = {}): Request {
  let sent = 0;
  return new Request(url(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= bytes) { controller.close(); return; }
        const size = Math.min(16 * 1024, bytes - sent);
        controller.enqueue(new Uint8Array(size).fill(0x20));
        sent += size;
      },
    }),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

/** A valid skill archive of about `padding` incompressible bytes. */
function skillArchive(padding: number): Buffer {
  const source = mkdtempSync(join(temporary, 'source-'));
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'SKILL.md'), '# Fixture\n');
  if (padding) writeFileSync(join(source, 'padding.bin'), randomBytes(padding));
  const file = join(temporary, `archive-${randomBytes(4).toString('hex')}.tgz`);
  assert.equal(spawnSync('tar', ['-czf', file, '-C', source, '.']).status, 0);
  return readFileSync(file);
}

store.createSkill({ slug: 'limits-example', name: 'Limits example', description: 'Synthetic fixture', homepage: null, enabled: true });

test('the anonymous sign-in refuses a large body before parsing it', async () => {
  const big = JSON.stringify({ username: 'fixture-user', password: 'x', padding: 'y'.repeat(appModule.MAX_JSON_BODY_BYTES) });
  const declared = await app.request(url('/auth/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: big });
  assert.equal(declared.status, 413);
  assert.deepEqual((await declared.json() as { error: { code: string; message: string } }).error.code, 'too_large');
  // Without a Content-Length the limit holds while the body streams.
  assert.equal((await app.fetch(chunked('/auth/login', appModule.MAX_JSON_BODY_BYTES + 1))).status, 413);
  // A body within the limit still reaches the handler.
  assert.equal((await app.fetch(chunked('/auth/login', 1024))).status, 400);
});

test('receipts accept a full 1000-entry report but not more than their own limit', async () => {
  const token = store.enrollTarget('agent-1', 'stable', null);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const skills: Record<string, { version: string; sha256: string }> = {};
  for (let index = 0; index < 1000; index++) skills[`s${String(index).padStart(3, '0')}-${'a'.repeat(57)}`] = { version: `1.0.0-${'b'.repeat(58)}`, sha256: 'c'.repeat(64) };
  const body = JSON.stringify({ status: 'activated', skills });
  assert.ok(body.length > appModule.MAX_JSON_BODY_BYTES);
  assert.equal((await app.request(url('/v1/agent/receipts/agent-1'), { method: 'POST', headers, body })).status, 200);
  assert.equal((await app.fetch(chunked('/v1/agent/receipts/agent-1', appModule.MAX_RECEIPT_BODY_BYTES + 1, headers))).status, 413);
  // Without a valid target token the body is never read.
  assert.equal((await app.fetch(chunked('/v1/agent/receipts/agent-1', 1024, { authorization: 'Bearer wrong' }))).status, 401);
});

test('other administration routes keep the small limit', async () => {
  const response = await app.fetch(chunked('/admin/skills', appModule.MAX_JSON_BODY_BYTES + 1, { cookie: admin }));
  assert.equal(response.status, 413);
});

test('a JSON release upload above the small limit is accepted', async () => {
  const archive = skillArchive(256 * 1024);
  const response = await app.request(url('/admin/skills/limits-example/releases'), {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ version: '1.0.0', archiveBase64: archive.toString('base64') }),
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json() as { sha256: string }).sha256, createHash('sha256').update(archive).digest('hex'));
});

test('a raw application/gzip release upload stores the exact bytes', async () => {
  const archive = skillArchive(128 * 1024);
  const upload = (query: string, body: Buffer, headers: Record<string, string> = {}) => app.request(url(`/admin/skills/limits-example/releases${query}`), {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/gzip', ...headers }, body: new Uint8Array(body),
  });
  const response = await upload('?version=1.1.0&notes=Raw%20upload&minHermesVersion=1.0.0', archive);
  assert.equal(response.status, 201);
  const release = await response.json() as { version: string; sha256: string; notes: string; minHermesVersion: string };
  assert.deepEqual([release.version, release.notes, release.minHermesVersion], ['1.1.0', 'Raw upload', '1.0.0']);
  assert.equal(release.sha256, createHash('sha256').update(archive).digest('hex'));
  const audit = (store.listAudit(1, Number.MAX_SAFE_INTEGER) as Array<{ action: string; subject: string }>)[0];
  assert.deepEqual([audit?.action, audit?.subject], ['release.create', 'limits-example@1.1.0']);
  // Immutable, validated and authenticated like the JSON form.
  assert.equal((await upload('?version=1.1.0', archive)).status, 409);
  assert.equal((await upload('', archive)).status, 400);
  assert.equal((await upload('?version=1.2.0&unknown=1', archive)).status, 400);
  assert.equal((await upload('?version=1.2.0&version=1.3.0', archive)).status, 400);
  assert.equal((await upload('?version=1.2.0', Buffer.from('not an archive'))).status, 400);
  assert.equal((await upload('?version=1.2.0', archive, { 'content-type': 'application/x-gzip' })).status, 201);
  const anonymous = await app.request(url('/admin/skills/limits-example/releases?version=1.3.0'), { method: 'POST', headers: { 'content-type': 'application/gzip' }, body: new Uint8Array(archive) });
  assert.equal(anonymous.status, 401);
  // The raw form is bounded by the archive limit itself.
  const oversized = await app.fetch(chunked('/admin/skills/limits-example/releases?version=1.4.0', appModule.MAX_ARCHIVE_BYTES + 1, { cookie: admin, 'content-type': 'application/gzip' }));
  assert.equal(oversized.status, 413);
});

test('archives stream with their length and are hashed again only when the file changes', async () => {
  const bytes = Buffer.from('synthetic streamed archive bytes');
  const archivePath = join(temporary, 'streamed.tgz');
  writeFileSync(archivePath, bytes);
  store.addRelease({ skillSlug: 'limits-example', version: '2.0.0', sha256: createHash('sha256').update(bytes).digest('hex'), archivePath, notes: null, createdAt: new Date().toISOString() });
  store.promoteRelease('limits-example', '2.0.0', 'stable');
  const download = () => app.request(url('/v1/skills/limits-example/releases/2.0.0/archive'));
  const first = await download();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-length'), String(bytes.length));
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), bytes);
  const parallel = await Promise.all(Array.from({ length: 8 }, download));
  for (const response of parallel) assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  // Same length, new content and a new mtime: the changed file is hashed again and refused.
  writeFileSync(archivePath, Buffer.from('tampered streamed archive bytes!'));
  utimesSync(archivePath, new Date(), new Date(Date.now() + 60_000));
  const tampered = await download();
  assert.equal(tampered.status, 500);
  assert.equal((await tampered.json() as { error: { code: string } }).error.code, 'archive_digest_mismatch');
  rmSync(archivePath);
  assert.equal((await download()).status, 404);
});

test('readiness probes share one run within the cache window', async () => {
  const original = store.readiness;
  let runs = 0;
  store.readiness = () => { runs++; return { ready: true, missingArchives: 0 }; };
  // Start past any earlier run's window.
  mock.timers.enable({ apis: ['Date'], now: Date.now() + appModule.READINESS_CACHE_MS + 1 });
  try {
    for (const path of ['/health/ready', '/healthz', '/health/ready', '/healthz']) assert.equal((await app.request(url(path))).status, 200);
    assert.equal(runs, 1);
    mock.timers.tick(appModule.READINESS_CACHE_MS);
    assert.equal((await app.request(url('/healthz'))).status, 200);
    assert.equal(runs, 2);
  } finally {
    mock.timers.reset();
    store.readiness = original;
  }
});
