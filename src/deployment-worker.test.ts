import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
const temporary = mkdtempSync(join(tmpdir(), 'skills-rehearsal-test-'));
process.env.HIVE_SKILLS_DATA_DIR = temporary;
process.env.HIVE_SKILLS_SESSION_SECRET =
  'obviously-fake-worker-session-secret-0123456789';
process.env.HIVE_AUTO_MIGRATE = 'true';
await (await import('./upgrade.js')).skillsMigration([], true);
const { store } = await import('./db.js');
const { startDeploymentWorker } = await import('./deployment-worker.js');
after(() => rmSync(temporary, { recursive: true, force: true }));
for (const flag of [
  'HIVE_REHEARSAL',
  'HIVE_SKILLS_DEPLOYMENT_WORKER_ENABLED',
]) {
  test(`${flag} prevents recovery and dispatch of existing jobs`, async () => {
    store.createDeployment(
      'fixture-' + flag.toLowerCase().replaceAll('_', '-'),
      'admin',
    );
    store.claimDeployment();
    const before = store.listDeployments();
    process.env[flag] = flag === 'HIVE_REHEARSAL' ? 'true' : 'false';
    const stop = startDeploymentWorker();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await stop();
    assert.deepEqual(store.listDeployments(), before);
    delete process.env[flag];
  });
}
