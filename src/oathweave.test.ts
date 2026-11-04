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
) =>
  new SignJWT({
    actorType: 'USER',
    sessionId: 'fake-session',
    clientId: 'hivexui-hiveskills',
    roles: ['SUPER_ADMIN'],
    permissions,
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
test('browser deployment requests cannot invoke the legacy host execution worker',async()=>{
  const response=await app.request('/admin/deployments/synthetic-target',{method:'POST',headers:{Authorization:'Bearer '+await token('hiveskills',['hiveskills:deploy']),'Content-Type':'application/json'},body:'{}'});
  assert.equal(response.status,503);
  assert.match(await response.text(),/Magnus job adapter/);
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
