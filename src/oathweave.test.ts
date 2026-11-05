import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

const temporary = mkdtempSync(join(tmpdir(), 'skills-identity-test-'));
process.env.HIVE_AUTO_MIGRATE = 'true';
process.env.HIVE_SKILLS_DATA_DIR = temporary;
process.env.HIVE_SKILLS_SESSION_SECRET =
  'obviously-fake-test-session-secret-0123456789';
process.env.HIVE_SKILLS_ADMIN_USERS = 'admin';
process.env.HIVESKILLS_OATHWEAVE_IDENTITIES_JSON = JSON.stringify([
  {
    issuer: 'https://identity.example.com',
    subject: 'fake-user',
    localId: 'admin',
  },
]);
process.env.OATHWEAVE_ISSUER = 'https://identity.example.com';
process.env.OATHWEAVE_JWKS_URL = 'https://identity.example.com/jwks';
process.env.OATHWEAVE_USERINFO_URL = 'https://identity.example.com/userinfo';
const keys = await generateKeyPair('RS256');
const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: 'test' }] };
let active = true;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) =>
  String(input).endsWith('/jwks')
    ? Response.json(jwks)
    : active
      ? Response.json({ sub: 'fake-user' })
      : new Response('', { status: 401 });
await (await import('./upgrade.js')).skillsMigration([], true);
const app = (await import('./app.js')).default;
after(() => {
  globalThis.fetch = originalFetch;
  rmSync(temporary, { recursive: true, force: true });
});
const token = async (
  audience = 'hiveskills',
  permissions = ['hiveskills:read'],
  authenticatedAt?:number,
) =>
  new SignJWT({
    actorType: 'USER',
    sessionId: 'fake-session',
    clientId: 'hivexui-hiveskills',
    roles: ['SUPER_ADMIN'],
    permissions,
    ...(authenticatedAt===undefined?{}:{auth_time:authenticatedAt}),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setSubject('fake-user')
    .setIssuer(process.env.OATHWEAVE_ISSUER!)
    .setAudience(audience)
    .setJti('fake-jti')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys.privateKey);

test('direct identity reads do not promote roles to registry write access', async () => {
  const headers = {
    Authorization: 'Bearer ' + (await token()),
    'Content-Type': 'application/json',
  };
  assert.equal((await app.request('/admin/skills', { headers })).status, 200);
  assert.equal(
    (
      await app.request('/admin/skills', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          slug: 'synthetic',
          name: 'Synthetic skill',
          description: 'Test fixture',
        }),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await app.request('/admin/skills', {
        headers: { Authorization: 'Bearer ' + (await token('emberpath')) },
      })
    ).status,
    401,
  );
});
test('browser deployment requests cannot invoke the legacy host execution worker', async () => {
  const response = await app.request('/admin/deployments/synthetic-target', {
    method: 'POST',
    headers: {
      Authorization:
        'Bearer ' + (await token('hiveskills', ['hiveskills:deploy'])),
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /Magnus job adapter/);
});

test('browser release history omits archive storage paths and audit pages stay bounded', async () => {
  const { store } = await import('./db.js');
  store.createSkill({
    slug: 'browser-contract-fixture',
    name: 'Browser fixture',
    description: 'Synthetic registry test',
    homepage: null,
    enabled: true,
  });
  store.addRelease({
    skillSlug: 'browser-contract-fixture',
    version: '1.0.0',
    sha256: 'f'.repeat(64),
    archivePath: '/tmp/private-fixture-archive.tgz',
    notes: null,
    createdAt: new Date().toISOString(),
  });
  store.audit('admin', 'skill.fixture', 'browser-contract-fixture', {});
  const headers = { Authorization: 'Bearer ' + (await token()) };
  const releases = await app.request(
    '/admin/skills/browser-contract-fixture/releases',
    { headers },
  );
  assert.equal(releases.status, 200);
  const body = (await releases.json()) as Array<Record<string, unknown>>;
  assert.equal(body[0]?.version, '1.0.0');
  assert.equal(body[0]?.archivePath, undefined);
  const audit = await app.request('/admin/audit?limit=1', { headers });
  assert.equal(audit.status, 200);
  assert.equal(((await audit.json()) as unknown[]).length, 1);
  assert.equal(
    (await app.request('/admin/audit?limit=101', { headers })).status,
    400,
  );
  assert.equal(
    (await app.request('/admin/skills/browser-contract-fixture/releases'))
      .status,
    401,
  );
});
test('direct deployment approval requires scoped permissions, exact digest, recent sign-in and one-use ownership', async () => {
 process.env.HIVE_SKILLS_MAGNUS_EXECUTOR_JSON=JSON.stringify({url:'https://magnus.example.com',credentialFile:'/run/secrets/fixture-executor'});
 try {
  const {store}=await import('./db.js');store.saveTarget({name:'fixture-managed',host:'node.example.com',username:'deploy',enabled:true});store.enrollTarget('fixture-managed','stable',[]);
  const send=async(path:string,body:unknown,authTime?:number,permissions=['hiveskills:deploy'])=>app.request(path,{method:'POST',headers:{authorization:'Bearer '+await token('hiveskills',permissions,authTime),'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await send('/admin/deployments/fixture-managed',{},undefined,['hiveskills:write'])).status,403);
  const preview=await send('/admin/deployments/fixture-managed',{});assert.equal(preview.status,201);const job=await preview.json() as {id:string;publication_sha256:string;status:string};assert.equal(job.status,'awaiting_approval');
  const approve='/admin/deployments/jobs/'+job.id+'/approve';
  assert.equal((await send(approve,{publicationSha256:job.publication_sha256})).status,403);
  assert.equal((await send(approve,{publicationSha256:job.publication_sha256},Math.floor(Date.now()/1000)-600)).status,403);
  const now=Math.floor(Date.now()/1000);assert.equal((await send(approve,{publicationSha256:'b'.repeat(64)},now)).status,409);
  assert.equal((await send(approve,{publicationSha256:job.publication_sha256},now)).status,202);
  assert.equal((await send(approve,{publicationSha256:job.publication_sha256},now)).status,409);
 }finally{delete process.env.HIVE_SKILLS_MAGNUS_EXECUTOR_JSON}
});

test('revoked identity sessions cannot use registry APIs', async () => {
  active = false;
  assert.equal(
    (
      await app.request('/admin/skills', {
        headers: { Authorization: 'Bearer ' + (await token()) },
      })
    ).status,
    401,
  );
});
