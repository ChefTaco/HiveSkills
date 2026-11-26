import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { requestContext } from '@hivemagnus/hive-common/hono';
import { HiveError, errorJson, onError, rateLimited } from './errors.js';

const app = new Hono();
app.use('*', requestContext());
app.get('/not-found', () => { throw new HTTPException(404, { message: 'Skill not found' }); });
app.get('/unavailable', () => { throw new HTTPException(503, { message: 'internal adapter detail' }); });
app.get('/crash', () => { throw new Error('secret internal detail'); });
app.get('/coded', () => { throw new HiveError('deployment_adapter_unavailable', 'Skill execution requires the Magnus job adapter', { status: 503 }); });
app.get('/limited', () => { throw rateLimited(7); });
app.get('/returned', (c) => errorJson(c, 503, 'Hive is undergoing maintenance', 'maintenance'));
app.onError(onError);

const call = async (path: string) => {
  const response = await app.request(`https://registry.test${path}`, { headers: { 'x-request-id': 'fixture-request' } });
  return { status: response.status, headers: response.headers, body: await response.json() as { error: Record<string, unknown> } };
};

test('every error answer is the suite envelope with the request id', async () => {
  const missing = await call('/not-found');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: { code: 'not_found', message: 'Skill not found', requestId: 'fixture-request' } });
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await call('/returned')).body.error, { code: 'maintenance', message: 'Hive is undergoing maintenance', requestId: 'fixture-request' });
});

test('server-side failures never expose internal messages, coded ones keep theirs', async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (value: unknown) => { errors.push(value); };
  try {
    const unavailable = await call('/unavailable');
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.error.code, 'unavailable');
    assert.doesNotMatch(JSON.stringify(unavailable.body), /adapter detail/);
    const crash = await call('/crash');
    assert.equal(crash.status, 500);
    assert.equal(crash.body.error.code, 'internal');
    assert.doesNotMatch(JSON.stringify(crash.body), /secret internal detail/);
    assert.equal(errors.length, 1, 'only the unexpected error is logged');
  } finally { console.error = original; }
  const coded = await call('/coded');
  assert.deepEqual([coded.status, coded.body.error.code, coded.body.error.message], [503, 'deployment_adapter_unavailable', 'Skill execution requires the Magnus job adapter']);
});

test('a throttled answer carries Retry-After', async () => {
  const limited = await call('/limited');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '7');
  assert.equal(limited.body.error.code, 'rate_limited');
});
