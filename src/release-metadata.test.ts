import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const temporary = mkdtempSync(join(tmpdir(), 'hive-skills-release-test-'));
process.env.HIVE_AUTO_MIGRATE = 'true';
process.env.HIVE_SKILLS_DATA_DIR = temporary;
process.env.HIVE_SKILLS_SESSION_SECRET = 'obviously-fake-release-session-secret-0123456789';
process.env.HIVE_SKILLS_ADMIN_USERS = 'admin';
after(() => rmSync(temporary, { recursive: true, force: true }));

const { hash, releaseSchema } = await import('./release/runtime.js');
const { SKILLS_MIGRATIONS, skillsMigration, skillsRelease } = await import('./upgrade.js');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; hiveRelease?: unknown };

test('the migration release is this package, and its skills schema checksum is unchanged', () => {
  assert.equal(pkg.hiveRelease, undefined, 'package.json carries no frozen bundle manifest');
  const release = releaseSchema.parse(skillsRelease());
  assert.equal(release.version, pkg.version);
  assert.deepEqual(Object.keys(release.components), ['@hivemagnus/hive-skills']);
  // The migrations every installation recorded under the legacy 1.2.2 manifest come first, unchanged:
  // the list is append-only, so earlier installations see only the new entries as pending.
  assert.deepEqual(SKILLS_MIGRATIONS.slice(0, 3).map((m) => [m.id, m.checksum]), [
    ['managed-format-1', 'b73f6f050c25fd3a2a31623d703aebc14d7997598f60e35d4d90f0f99a9a4cfe'],
    ['managed-format-2', 'a9803de4fb36b043e8ab0f7e8fe4f09f652ffa7c9f1d8eed3674a6e4756544f1'],
    ['managed-format-3', 'f0e4ce285573b35b41865eb979dc2959b345342b3450604d7e43d68d969c792f'],
  ]);
  assert.ok(SKILLS_MIGRATIONS.every((m) => m.component === 'skills' && m.impact === 'fast'));
  assert.equal(release.dataCompatibility.skills, '^1.1.0');
});

test('migrate keeps a state file written under the legacy 1.2.2 manifest readable', async () => {
  await skillsMigration([], true);
  const stateFile = join(temporary, '.hive-skills-schema.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { checksum: string; version: string; readableBy: string };
  assert.equal(state.version, pkg.version);
  // Rewrite it the way 1.9.1 and older recorded it.
  const { writeFileSync } = await import('node:fs');
  writeFileSync(stateFile, JSON.stringify({ ...state, version: '1.2.2' }));
  const lines: string[] = [];
  const log = console.log;
  console.log = (line: string) => { lines.push(line); };
  try { await skillsMigration(['--plan']); } finally { console.log = log; }
  assert.deepEqual((JSON.parse(lines[0]!) as { pending: unknown[] }).pending, []);
});

test('a data directory recorded before the advisory migration applies it', async () => {
  await skillsMigration([], true);
  const stateFile = join(temporary, '.hive-skills-schema.json');
  const { writeFileSync } = await import('node:fs');
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, string>;
  const legacy = hash(JSON.stringify(SKILLS_MIGRATIONS.slice(0, 3).map((m) => [m.id, m.checksum])));
  writeFileSync(stateFile, JSON.stringify({ ...state, checksum: legacy, version: '1.9.1' }));
  const plan = async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => { lines.push(line); };
    try { await skillsMigration(['--plan']); } finally { console.log = log; }
    return JSON.parse(lines[0]!) as { pending: unknown[] };
  };
  assert.equal((await plan()).pending.length, 1);
  await skillsMigration([], true);
  assert.deepEqual((await plan()).pending, []);
});

test('health and update status report this release, not a legacy bundle', async () => {
  const app = (await import('./app.js')).default;
  const live = await (await app.request('https://registry.test/health/live')).json() as { version: string; release: string };
  assert.equal(live.version, pkg.version);
  assert.equal(live.release, pkg.version);
  const { createSession } = await import('./auth.js');
  const updates = await app.request('https://registry.test/admin/updates', { headers: { cookie: `hive_skills_session=${createSession('admin')}` } });
  assert.equal(updates.status, 200);
  assert.equal((await updates.json() as { installed: string }).installed, pkg.version);
});
