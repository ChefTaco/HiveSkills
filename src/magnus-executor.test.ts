import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const temporary = mkdtempSync(join(tmpdir(), 'hive-skills-executor-test-'));
process.env.HIVE_AUTO_MIGRATE = 'true';
process.env.HIVE_SKILLS_DATA_DIR = temporary;
process.env.HIVE_SKILLS_SESSION_SECRET = 'obviously-fake-executor-session-secret-0123456789';
process.env.HIVE_SKILLS_ADMIN_USERS = 'admin';
after(() => rmSync(temporary, { recursive: true, force: true }));

await (await import('./upgrade.js')).skillsMigration([], true);
const { store, deploymentJournal } = await import('./db.js');
const executor = await import('./magnus-deployment.js');

const secretFile = join(temporary, 'client-secret');
writeFileSync(secretFile, 'obviously-fake-client-secret\n');
chmodSync(secretFile, 0o600);
const oathweave = { tokenUrl: 'https://oathweave.example.com/oauth/token', clientId: 'hiveskills-executor', clientSecretFile: secretFile, audience: 'magnus-executor' };
const configure = (value: unknown) => { process.env.HIVE_SKILLS_MAGNUS_EXECUTOR_JSON = JSON.stringify(value); };

let issued = 0;
const tokenRequests: URLSearchParams[] = [];
// Each test uses its own job and target state; the provider is shared per client configuration.
executor.executorTokenProvider(oathweave, {
  fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
    tokenRequests.push(new URLSearchParams(String(init?.body)));
    issued++;
    return new Response(JSON.stringify({ access_token: `fake-token-${issued}`, token_type: 'Bearer', expires_in: 300 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch,
  failureBackoffMs: 0,
});

store.seedTarget({ name: 'agent-1', host: 'agent-1.example.com', username: 'deploy', enabled: true });
const job = () => {
  const preview = deploymentJournal.preview('agent-1', 'admin', { schemaVersion: 1, channel: 'stable', skills: [] });
  return String(preview.id);
};
const reply = (jobId: string) => ({ status: 200, body: JSON.stringify({ jobId, status: 'completed', result: 'activated' }) });

test('the executor configuration takes exactly one credential source', () => {
  const base = { url: 'https://magnus.example.com' };
  assert.equal(executor.executorConfiguration.safeParse({ ...base, credentialFile: '/x' }).success, true);
  assert.equal(executor.executorConfiguration.safeParse({ ...base, oathweave }).success, true);
  assert.equal(executor.executorConfiguration.safeParse(base).success, false);
  assert.equal(executor.executorConfiguration.safeParse({ ...base, credentialFile: '/x', oathweave }).success, false);
  assert.equal(executor.executorConfiguration.safeParse({ ...base, oathweave: { ...oathweave, tokenUrl: 'http://oathweave.example.com/token' } }).success, false);
  assert.equal(executor.executorConfiguration.safeParse({ ...base, oathweave: { ...oathweave, audience: undefined } }).success, false);
});

test('an Oathweave client sends a short-lived audience-bound token and re-authenticates once after 401', async () => {
  configure({ url: 'https://magnus.example.com', oathweave });
  const id = job();
  const seen: string[] = [];
  let first = true;
  const answer = await executor.executeMagnusJob(id, false, async (url, options) => {
    seen.push(options.bearer);
    assert.equal(url.pathname, `/api/v1/hiveskills/jobs/${id}`);
    assert.equal(options.method, 'POST');
    if (first) { first = false; return { status: 401, body: '' }; }
    return reply('magnus-job-1');
  });
  assert.deepEqual(answer, { jobId: 'magnus-job-1', status: 'completed', result: 'activated' });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], 'the retry uses a fresh token');
  assert.equal(tokenRequests.at(-1)?.get('grant_type'), 'client_credentials');
  assert.equal(tokenRequests.at(-1)?.get('audience'), 'magnus-executor');
  // A cached token is reused, not fetched per call.
  const before = issued;
  await executor.executeMagnusJob(id, true, async () => reply('magnus-job-1'));
  assert.equal(issued, before);
});

test('a second 401 is a rejection, not another retry', async () => {
  configure({ url: 'https://magnus.example.com', oathweave });
  const id = job();
  let calls = 0;
  await assert.rejects(executor.executeMagnusJob(id, true, async () => { calls++; return { status: 401, body: '' }; }), /bounded job result/);
  assert.equal(calls, 2);
});

test('a static credential file is still accepted and never retried', async () => {
  const credentialFile = join(temporary, 'credential');
  writeFileSync(credentialFile, 'obviously-fake-static-credential-0123456789');
  chmodSync(credentialFile, 0o600);
  configure({ url: 'https://magnus.example.com', credentialFile });
  const id = job();
  let calls = 0;
  await assert.rejects(executor.executeMagnusJob(id, true, async (_url, options) => {
    calls++;
    assert.equal(options.bearer, 'obviously-fake-static-credential-0123456789');
    return { status: 401, body: '' };
  }));
  assert.equal(calls, 1);
  chmodSync(credentialFile, 0o644);
  await assert.rejects(executor.executeMagnusJob(id, true, async () => reply('x')), executor.ExecutorNotDispatchedError);
});

test('the worker fails a job whose credential is unavailable instead of marking it uncertain', async () => {
  const credentialFile = join(temporary, 'open-credential');
  writeFileSync(credentialFile, 'obviously-fake-static-credential-0123456789');
  chmodSync(credentialFile, 0o644);
  configure({ url: 'https://magnus.example.com', credentialFile });
  const id = job();
  const preview = deploymentJournal.get(id);
  deploymentJournal.approve(id, 'admin', String(preview.publication_sha256));
  const stop = executor.startMagnusDeploymentWorker();
  try {
    for (let wait = 0; wait < 40 && deploymentJournal.get(id).status !== 'failed'; wait++) await new Promise((resolve) => setTimeout(resolve, 100));
    const done = deploymentJournal.get(id);
    assert.equal(done.status, 'failed');
    assert.equal(done.result, 'Magnus executor credential unavailable; nothing was dispatched');
  } finally { await stop(); }
});
