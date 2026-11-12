import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

delete process.env.HIVEXUI_URL;
process.env.HIVE_AUTO_MIGRATE = 'true';
process.env.HIVE_SKILLS_DATA_DIR = mkdtempSync(join(tmpdir(), 'hive-skills-stub-test-'));
process.env.HIVE_SKILLS_SESSION_SECRET = 'stub-test-session-secret-0123456789abcdef';
process.env.HIVE_SKILLS_ADMIN_USERS = 'admin';
process.env.HIVE_SKILLS_PUBLIC_URL = 'https://registry.example.test:4030';

await (await import('./upgrade.js')).skillsMigration([], true);
const { parseHiveXuiUrl, renderHiveXuiStub } = await import('./hivexui-stub.js');
const app = (await import('./app.js')).default;

const stubCsp = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

test('serves the HiveXUI stub at the retired UI path without HIVEXUI_URL', async () => {
  for (const method of ['GET', 'HEAD']) {
    const response = await app.request('https://registry.example.test/', { method });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-security-policy'), stubCsp);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('location'), null);
    if (method === 'HEAD') continue;
    const body = await response.text();
    assert.match(body, /<html lang="en">/);
    assert.match(body, /<title>HiveSkills is managed in HiveXUI<\/title>/);
    assert.match(body, /<h1>HiveSkills is managed in HiveXUI<\/h1>/);
    assert.match(body, /<p>Open HiveXUI to manage HiveSkills\. Operators can set HIVEXUI_URL so this address redirects there\.<\/p>/);
    assert.doesNotMatch(body, /<a |<script|<link /);
  }
});

test('API routes are unaffected in stub mode', async () => {
  const health = await app.request('https://registry.example.test/healthz');
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-type') ?? '', /application\/json/);
  const catalog = await app.request('https://registry.example.test/v1/skills');
  assert.equal(catalog.status, 200);
  assert.ok(Array.isArray(await catalog.json()));
  assert.equal((await app.request('https://registry.example.test/admin/skills')).status, 401);
});

test('HIVEXUI_URL accepts absolute http(s) URLs and normalizes them', () => {
  assert.equal(parseHiveXuiUrl(undefined), undefined);
  assert.equal(parseHiveXuiUrl(''), undefined);
  assert.equal(parseHiveXuiUrl('  '), undefined);
  assert.equal(parseHiveXuiUrl('https://hivexui.example.com'), 'https://hivexui.example.com/');
  assert.equal(parseHiveXuiUrl('http://hivexui.example.test:8443/ui?x=1'), 'http://hivexui.example.test:8443/ui?x=1');
});

test('invalid HIVEXUI_URL values are rejected', () => {
  for (const value of ['ftp://x', 'not a url', '/relative', 'https://user:pw@example.com/', 'https://example.com/#frag', 'javascript:alert(1)']) {
    assert.throws(() => parseHiveXuiUrl(value), /HIVEXUI_URL must be an absolute http\(s\) URL/, value);
  }
});

test('startup configuration fails on an invalid HIVEXUI_URL', () => {
  const config = pathToFileURL(resolve(import.meta.dirname, 'config.js')).href;
  for (const value of ['ftp://x', 'not a url', '/relative', 'https://user:pw@example.com/']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(config)})`], {
      cwd: mkdtempSync(join(tmpdir(), 'hive-skills-stub-config-')),
      env: { ...process.env, HIVEXUI_URL: value },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.notEqual(result.status, 0, value);
    assert.match(result.stderr, /HIVEXUI_URL must be an absolute http\(s\) URL/, value);
  }
});

test('stub link escapes the configured URL', () => {
  const body = renderHiveXuiStub('HiveSkills', `https://example.com/?a=1&b="2"&c='3'<x>`);
  assert.match(body, /<a href="https:\/\/example\.com\/\?a=1&amp;b=&quot;2&quot;&amp;c=&#39;3&#39;&lt;x&gt;">Open HiveXUI<\/a> to manage HiveSkills\./);
});
