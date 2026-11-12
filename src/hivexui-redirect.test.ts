import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.HIVEXUI_URL = 'https://hivexui.example.com/skills?view=list&tab=1';
process.env.HIVE_AUTO_MIGRATE = 'true';
process.env.HIVE_SKILLS_DATA_DIR = mkdtempSync(join(tmpdir(), 'hive-skills-redirect-test-'));
process.env.HIVE_SKILLS_SESSION_SECRET = 'redirect-test-session-secret-0123456789ab';
process.env.HIVE_SKILLS_ADMIN_USERS = 'admin';
process.env.HIVE_SKILLS_PUBLIC_URL = 'https://registry.example.test:4030';

await (await import('./upgrade.js')).skillsMigration([], true);
const app = (await import('./app.js')).default;

test('redirects the retired UI path to HIVEXUI_URL', async () => {
  for (const [method, path] of [['GET', '/'], ['HEAD', '/'], ['GET', '/?page=skills']] as const) {
    const response = await app.request(`https://registry.example.test${path}`, { method, redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://hivexui.example.com/skills?view=list&tab=1');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (method === 'HEAD') continue;
    const body = await response.text();
    assert.match(body, /<title>HiveSkills is managed in HiveXUI<\/title>/);
    assert.match(body, /<p><a href="https:\/\/hivexui\.example\.com\/skills\?view=list&amp;tab=1">Open HiveXUI<\/a> to manage HiveSkills\.<\/p>/);
  }
});

test('API routes are unaffected in redirect mode', async () => {
  const health = await app.request('https://registry.example.test/healthz', { redirect: 'manual' });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('location'), null);
  const catalog = await app.request('https://registry.example.test/v1/skills', { redirect: 'manual' });
  assert.equal(catalog.status, 200);
  assert.ok(Array.isArray(await catalog.json()));
  assert.equal((await app.request('https://registry.example.test/admin/skills', { redirect: 'manual' })).status, 401);
});
