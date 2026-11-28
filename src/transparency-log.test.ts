import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { keygen, signRelease, signRevocations } from '../scripts/sign-release.mjs';
import { parsePublisherKeys } from '../scripts/archive-utils.mjs';
import { entryHash, verifyTransparencyLog, type LogHead, type LogRow } from '../scripts/transparency-log.mjs';
import { main as verifyCli } from '../scripts/verify-transparency-log.mjs';

const temporary = mkdtempSync(join(tmpdir(), 'hive-skills-log-test-'));
after(() => rmSync(temporary, { recursive: true, force: true }));
const publisherFile = join(temporary, 'publisher.pem');
const publisher = keygen({ out: publisherFile, keyId: 'publisher-2026' });
const repository = new URL('..', import.meta.url).pathname;

process.env.HIVE_AUTO_MIGRATE = 'true';
process.env.HIVE_SKILLS_DATA_DIR = temporary;
process.env.HIVE_SKILLS_SESSION_SECRET = 'obviously-fake-log-session-secret-0123456789';
process.env.HIVE_SKILLS_ADMIN_USERS = 'admin';
process.env.HIVE_SKILLS_PUBLIC_URL = 'https://skills.example.com';
process.env.HIVE_SKILLS_PUBLISHER_KEYS = JSON.stringify([publisher]);
delete process.env.HIVE_SKILLS_REVOCATION_KEYS;

await (await import('./upgrade.js')).skillsMigration([], true);
// Releases stored before the log existed: written straight to the database, as an older registry did.
const { DatabaseSync } = await import('./sqlite.js');
const raw = new DatabaseSync(join(temporary, 'registry.sqlite'), { enableForeignKeyConstraints: true });
const legacyDigest = createHash('sha256').update('legacy').digest('hex');
raw.prepare("INSERT INTO skills VALUES ('legacy','Legacy','Synthetic fixture',NULL,1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run();
raw.prepare("INSERT INTO releases(skill_slug,version,sha256,archive_path,notes,created_at) VALUES ('legacy','1.0.0',?,'/nonexistent','old','2026-01-01T00:00:00.000Z')").run(legacyDigest);
raw.prepare("INSERT INTO release_signatures VALUES ('legacy','1.0.0','publisher-2026',?,'2026-01-01T00:00:00.000Z')").run(signRelease({ key: publisherFile, keyId: 'publisher-2026', slug: 'legacy', version: '1.0.0', sha256: legacyDigest }).signature);
raw.prepare("INSERT INTO releases(skill_slug,version,sha256,archive_path,notes,created_at) VALUES ('legacy','1.1.0',?,'/nonexistent','old','2026-01-02T00:00:00.000Z')").run(createHash('sha256').update('legacy-2').digest('hex'));
raw.close();

const { store } = await import('./db.js');
const { createSession } = await import('./auth.js');
const app = (await import('./app.js')).default;
const admin = { cookie: `hive_skills_session=${createSession('admin')}` };
const url = (path: string) => `https://skills.example.com${path}`;
store.saveTarget({ name: 'agent-1', host: 'agent.example.com', username: 'hermes', enabled: true });
const targetToken = store.enrollTarget('agent-1', 'stable', null);

function archive(label: string): Buffer {
  const source = join(temporary, `source-${label}`);
  mkdirSync(source);
  writeFileSync(join(source, 'SKILL.md'), `# ${label}\n`);
  const file = join(temporary, `${label}.tgz`);
  assert.equal(spawnSync('tar', ['-czf', file, '-C', source, '.']).status, 0);
  return readFileSync(file);
}
const read = async (): Promise<{ head: LogHead; entries: LogRow[] }> => {
  const head = await (await app.request(url('/v1/transparency/head'), { headers: admin })).json() as LogHead;
  const page = await (await app.request(url('/v1/transparency/entries?limit=500'), { headers: admin })).json() as { entries: LogRow[] };
  return { head, entries: page.entries };
};
const logPublicKey = () => store.transparencyHead().logKey.publicKey;

test('releases stored before the log existed are recorded once, marked as backfilled', () => {
  const entries = store.transparencyEntries(0, 10).map((row) => JSON.parse(row.entry) as { kind: string; subject: { slug: string; version: string; backfilled?: boolean; signature: unknown } });
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.subject.version, entry.subject.backfilled, entry.subject.signature !== null]), [
    ['release.published', '1.0.0', true, true],
    ['release.published', '1.1.0', true, false],
  ]);
  assert.equal(store.backfillTransparencyLog(), 0, 'never twice');
  const keyFile = join(temporary, 'transparency-log-key.pem');
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
});

test('uploads and later signatures append signed, linked entries in the same transaction', async () => {
  store.createSkill({ slug: 'logged', name: 'Logged', description: 'Synthetic fixture', homepage: null, enabled: true });
  const bytes = archive('logged');
  const created = await app.request(url('/admin/skills/logged/releases'), { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ version: '1.0.0', archiveBase64: bytes.toString('base64') }) });
  assert.equal(created.status, 201);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const signature = signRelease({ key: publisherFile, keyId: 'publisher-2026', slug: 'logged', version: '1.0.0', sha256 });
  assert.equal((await app.request(url('/admin/skills/logged/releases/1.0.0/signature'), { method: 'PUT', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ keyId: 'publisher-2026', value: signature.signature }) })).status, 200);
  const { head, entries } = await read();
  assert.equal(head.size, 4);
  const last = JSON.parse(entries[3]!.entry) as { kind: string; previousHash: string; subject: { signature: { keyId: string } } };
  assert.equal(last.kind, 'release.signed');
  assert.equal(last.previousHash, entries[2]!.hash);
  assert.equal(last.subject.signature.keyId, 'publisher-2026');
  // A release whose log entry cannot be written is not stored either.
  assert.throws(() => store.addRelease({ skillSlug: 'logged', version: '1.0.0', sha256, archivePath: '/nonexistent', notes: null, createdAt: new Date().toISOString() }));
  assert.equal(store.transparencyHead().size, 4);
});

test('the database refuses to change or delete log entries and revocation lists', () => {
  const db = new DatabaseSync(join(temporary, 'registry.sqlite'));
  try {
    assert.throws(() => db.prepare("UPDATE transparency_log SET entry='{}' WHERE log_index=0").run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM transparency_log WHERE log_index=0').run(), /append-only/);
    db.prepare("INSERT INTO revocation_lists VALUES (99,'{}','x','k','s','test','2026-01-01T00:00:00.000Z')").run();
    assert.throws(() => db.prepare('DELETE FROM revocation_lists').run(), /append-only/);
    assert.throws(() => db.prepare('UPDATE revocation_lists SET payload=? WHERE sequence=99').run('[]'), /append-only/);
  } finally { db.close(); }
});

test('verification detects every change to the log', async () => {
  const { head, entries } = await read();
  const publisherKeys = parsePublisherKeys(JSON.stringify([publisher]));
  const ok = verifyTransparencyLog({ entries, head, logKeys: logPublicKey(), publisherKeys });
  assert.deepEqual([ok.size, ok.releases, ok.releaseSignatures, ok.warnings], [4, 3, 2, []]);
  const tofu = verifyTransparencyLog({ entries, head });
  assert.match(tofu.warnings.join(), /No log key was pinned/);
  const fails = (changed: { entries?: LogRow[]; head?: LogHead; logKeys?: string }, pattern: RegExp) =>
    assert.throws(() => verifyTransparencyLog({ entries: changed.entries ?? entries, head: changed.head ?? head, logKeys: changed.logKeys ?? logPublicKey(), publisherKeys }), pattern);
  const edited = entries[1]!.entry.replace('"1.1.0"', '"1.1.1"');
  fails({ entries: entries.map((row, index) => index === 1 ? { ...row, entry: edited } : row) }, /entry 1: hash does not match/);
  // Re-hashed but not re-signed.
  fails({ entries: entries.map((row, index) => index === 1 ? { ...row, entry: edited, hash: entryHash(edited) } : row) }, /entry 1: log signature does not verify/);
  fails({ entries: [entries[0]!, entries[2]!, entries[3]!] }, /entry 1: missing or out of order/);
  fails({ entries: entries.slice(0, 3) }, /head names 4 entries but 3/);
  fails({ head: { ...head, headHash: entries[2]!.hash } }, /head hash does not match/);
  fails({ head: { ...head, signature: entries[0]!.signature } }, /head signature does not verify/);
  fails({ logKeys: keygen({ out: join(temporary, 'other-log.pem'), keyId: 'other' }).publicKey }, /not trusted/);
  // A publisher signature swapped for one over a different digest.
  const forged = signRelease({ key: publisherFile, keyId: 'publisher-2026', slug: 'logged', version: '1.0.0', sha256: 'f'.repeat(64) }).signature;
  const swapped = entries[3]!.entry.replace(/"value":"[^"]+"/, `"value":"${forged}"`);
  assert.throws(() => verifyTransparencyLog({ entries: entries.map((row, index) => index === 3 ? { ...row, entry: swapped } : row), head, logKeys: logPublicKey(), publisherKeys }), /entry 3/);
  // A head seen before must stay a prefix.
  verifyTransparencyLog({ entries, head, logKeys: logPublicKey(), knownHead: { size: 2, headHash: entries[1]!.hash } });
  assert.throws(() => verifyTransparencyLog({ entries, head, logKeys: logPublicKey(), knownHead: { size: 2, headHash: entries[0]!.hash } }), /rewritten/);
  assert.throws(() => verifyTransparencyLog({ entries, head, logKeys: logPublicKey(), knownHead: { size: 9, headHash: entries[0]!.hash } }), /shrank/);
});

test('entries page by index, and readers are targets or administrators only', async () => {
  const first = await (await app.request(url('/v1/transparency/entries?limit=3'), { headers: admin })).json() as { entries: LogRow[]; nextFrom: number | null };
  assert.deepEqual([first.entries.map((row) => row.index), first.nextFrom], [[0, 1, 2], 3]);
  const rest = await (await app.request(url('/v1/transparency/entries?from=3&limit=3'), { headers: admin })).json() as { entries: LogRow[]; nextFrom: number | null };
  assert.deepEqual([rest.entries.map((row) => row.index), rest.nextFrom], [[3], null]);
  for (const bad of ['limit=0', 'limit=501', 'from=-1', 'from=x']) assert.equal((await app.request(url(`/v1/transparency/entries?${bad}`), { headers: admin })).status, 400, bad);
  assert.equal((await app.request(url('/v1/transparency/head'))).status, 401);
  assert.equal((await app.request(url('/v1/transparency/entries'))).status, 401);
  assert.equal((await app.request(url('/v1/transparency/head'), { headers: { cookie: `hive_skills_session=${createSession('viewer')}` } })).status, 403);
  assert.equal((await app.request(url('/v1/transparency/head?target=agent-1'), { headers: { authorization: `Bearer ${targetToken}` } })).status, 200);
});

test('without revocation keys the registry refuses to publish revocation lists', async () => {
  const authority = join(temporary, 'authority.pem');
  keygen({ out: authority, keyId: 'revocations-2026' });
  const response = await app.request(url('/admin/revocations'), { method: 'PUT', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify(signRevocations({ key: authority, keyId: 'revocations-2026', list: { sequence: 1, keys: [], releases: [] } })) });
  assert.equal(response.status, 503);
  assert.equal((await response.json() as { error: { code: string } }).error.code, 'revocation_keys_unconfigured');
});

test('the verification CLI checks a live registry and a saved copy', async () => {
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => app.request(String(input), init)) as typeof fetch;
  const saved = join(temporary, 'log.json');
  const summary = await verifyCli(['--registry', 'https://skills.example.com', '--log-key', logPublicKey(), '--publisher-keys', JSON.stringify([publisher]), '--save', saved], { HIVE_SKILLS_TARGET: 'agent-1', HIVE_SKILLS_TARGET_TOKEN: targetToken }, fetchImpl);
  assert.equal(summary.size, 4);
  assert.equal(statSync(saved).mode & 0o777, 0o600);
  await assert.rejects(verifyCli(['--registry', 'https://skills.example.com'], { HIVE_SKILLS_TARGET: 'agent-1', HIVE_SKILLS_TARGET_TOKEN: 'wrong' }, fetchImpl), /HTTP 401/);
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(repository, 'scripts/verify-transparency-log.mjs'), ...args], { encoding: 'utf8' });
  const good = cli('--file', saved, '--log-key', logPublicKey(), '--known-head', `${summary.size}:${summary.headHash}`);
  assert.equal(good.status, 0, good.stderr);
  assert.equal((JSON.parse(good.stdout) as { ok: boolean }).ok, true);
  const dump = JSON.parse(readFileSync(saved, 'utf8')) as { head: LogHead; entries: LogRow[] };
  dump.entries.splice(1, 1);
  writeFileSync(saved, JSON.stringify(dump));
  const bad = cli('--file', saved, '--log-key', logPublicKey());
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /verify-transparency-log: entry 1: missing or out of order/);
  assert.equal(cli('--file', saved, '--registry', 'https://skills.example.com').status, 1);
});
