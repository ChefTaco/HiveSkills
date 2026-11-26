import { readFileSync, lstatSync } from 'node:fs';
import { request } from 'node:https';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { createServiceTokenProvider, type ServiceTokenProvider, type ServiceTokenProviderOptions } from '@hivemagnus/hive-common/oathweave';
import { maintenanceActive } from './release/runtime.js';
import { deploymentJournal, store } from './db.js';

const httpsUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
});

/**
 * `HIVE_SKILLS_MAGNUS_EXECUTOR_JSON`: an HTTPS URL without credentials, query or fragment, and
 * exactly one way to authenticate to it: `credentialFile`, a long-lived bearer read from a protected
 * file, or `oathweave`, this registry's own Oathweave client (`client_credentials`), which gives
 * short-lived tokens bound to the executor's `audience`.
 */
export const executorConfiguration = z.object({
  url: httpsUrl,
  credentialFile: z.string().min(1).optional(),
  oathweave: z.object({
    tokenUrl: httpsUrl,
    clientId: z.string().min(1).max(256),
    clientSecretFile: z.string().min(1),
    audience: z.string().min(1).max(256),
    scope: z.string().min(1).max(1024).optional(),
  }).strict().optional(),
  caFile: z.string().min(1).optional(),
}).strict().refine((value) => (value.credentialFile === undefined) !== (value.oathweave === undefined), {
  message: 'Configure exactly one of credentialFile or oathweave',
});
export type ExecutorConfiguration = z.infer<typeof executorConfiguration>;

export function magnusExecutorConfiguration() {
  if (!process.env.HIVE_SKILLS_MAGNUS_EXECUTOR_JSON) return null;
  return executorConfiguration.parse(JSON.parse(process.env.HIVE_SKILLS_MAGNUS_EXECUTOR_JSON));
}

export function requireMagnusExecutor() {
  if (!magnusExecutorConfiguration()) {
    throw new HTTPException(503, { message: 'Skill execution requires an explicitly configured Magnus job adapter; native agents and credentials are provisioned through the host installer' });
  }
}

const result = z.object({
  jobId: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'unknown', 'not_admitted']),
  result: z.string(),
}).strict();
type MagnusReply = z.infer<typeof result>;

/** The journal status for a Magnus reply: still running is uncertain; not admitted is a failure. */
export function journalStatus(status: MagnusReply['status']): 'completed' | 'failed' | 'unknown' {
  if (status === 'running') return 'unknown';
  if (status === 'not_admitted') return 'failed';
  return status;
}

/** A secret from a regular file owned by this process's user and closed to everyone else. */
function readProtectedSecret(file: string, minimum: number): string {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error('Protected current-owner Magnus credential file required');
  }
  const credential = readFileSync(file, 'utf8').trim();
  if (credential.length < minimum || /[\r\n]/.test(credential)) throw new Error('Invalid Magnus executor credential file');
  return credential;
}

/** One token provider per Oathweave client; it caches and refreshes the token itself. */
const providers = new Map<string, ServiceTokenProvider>();
export function executorTokenProvider(oathweave: NonNullable<ExecutorConfiguration['oathweave']>, overrides: Partial<ServiceTokenProviderOptions> = {}): ServiceTokenProvider {
  const key = JSON.stringify(oathweave);
  let provider = providers.get(key);
  if (!provider) {
    provider = createServiceTokenProvider({
      tokenUrl: oathweave.tokenUrl,
      clientId: oathweave.clientId,
      // Read once per provider; rotating the secret file takes a restart, as other suite secrets do.
      clientSecret: readProtectedSecret(oathweave.clientSecretFile, 16),
      audience: oathweave.audience,
      ...(oathweave.scope ? { scope: oathweave.scope } : {}),
      ...overrides,
    });
    providers.set(key, provider);
  }
  return provider;
}

/** No executor credential could be obtained, so nothing was sent to Magnus. */
export class ExecutorNotDispatchedError extends Error {}

/** The bearer for one executor request. */
async function executorBearer(config: ExecutorConfiguration): Promise<string> {
  try {
    if (config.oathweave) return await executorTokenProvider(config.oathweave).token();
    return readProtectedSecret(config.credentialFile!, 32);
  } catch (error) {
    throw new ExecutorNotDispatchedError(error instanceof Error ? error.message : 'Magnus executor credential unavailable');
  }
}

export type ExecutorAnswer = { status: number; body: string };
export type ExecutorTransport = (url: URL, options: { method: 'GET' | 'POST'; bearer: string; ca?: Buffer; body: string | null }) => Promise<ExecutorAnswer>;

/** HTTPS with a 125-second deadline and a 64 KiB answer bound. */
const httpsTransport: ExecutorTransport = (url, options) => new Promise<ExecutorAnswer>((resolve, reject) => {
  const req = request(url, {
    method: options.method,
    ...(options.ca ? { ca: options.ca } : {}),
    headers: { authorization: 'Bearer ' + options.bearer, 'content-type': 'application/json', 'cache-control': 'no-store' },
    timeout: 125_000,
  }, (res) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    res.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) {
        res.destroy();
        reject(new Error('Oversized Magnus job response'));
      } else chunks.push(chunk);
    });
    res.on('error', () => reject(new Error('Magnus job response interrupted')));
    res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('timeout', () => req.destroy(new Error('Magnus job response deadline exceeded')));
  req.on('error', () => reject(new Error('Magnus operation outcome requires reconciliation')));
  req.end(options.body);
});

/**
 * Dispatch an approved job to Magnus (POST), or with `reconcile` ask for the outcome of an earlier
 * dispatch of the same job id (GET) without replaying it. The reply is bounded to 64 KiB. With an
 * Oathweave client, a `401` (an expired or revoked token, refused before the job is admitted) is
 * retried once with a fresh token.
 */
export async function executeMagnusJob(id: string, reconcile = false, transport: ExecutorTransport = httpsTransport): Promise<MagnusReply> {
  const config = magnusExecutorConfiguration();
  if (!config) throw new Error('Magnus executor is not configured');
  const row = deploymentJournal.get(id);
  const url = new URL(config.url.replace(/\/$/, '') + '/api/v1/hiveskills/jobs/' + encodeURIComponent(id));
  if (reconcile) url.searchParams.set('target', String(row.target));
  const body = reconcile ? null : JSON.stringify({
    target: row.target,
    publicationSha256: row.publication_sha256,
    manifest: JSON.parse(String(row.manifest_json)),
    approvedBy: row.actor,
  });
  const send = async () => transport(url, {
    method: reconcile ? 'GET' : 'POST',
    bearer: await executorBearer(config),
    ...(config.caFile ? { ca: readFileSync(config.caFile) } : {}),
    body,
  });
  let answer = await send();
  if (answer.status === 401 && config.oathweave) {
    executorTokenProvider(config.oathweave).invalidate();
    answer = await send();
  }
  try {
    if (answer.status !== 200) throw new Error('Magnus job rejected or unavailable');
    return result.parse(JSON.parse(answer.body));
  } catch {
    throw new Error('Magnus did not return a bounded job result');
  }
}

/** Dispatch approved jobs one at a time. A dispatch whose outcome is uncertain is never replayed. */
export function startMagnusDeploymentWorker(): () => Promise<void> {
  if (process.env.HIVE_REHEARSAL === 'true' || process.env.HIVE_SKILLS_DEPLOYMENT_WORKER_ENABLED === 'false' || !magnusExecutorConfiguration()) {
    return async () => {};
  }
  let active: Promise<void> | null = null;
  deploymentJournal.recover();
  const timer = setInterval(() => {
    if (active || maintenanceActive('/worker')) return;
    const job = deploymentJournal.claim();
    if (!job) return;
    const id = String(job.id);
    if (!store.getTarget(String(job.target))) {
      deploymentJournal.outcome(id, 'failed', 'Target disabled before dispatch');
      return;
    }
    active = (async () => {
      try {
        const reply = await executeMagnusJob(id);
        deploymentJournal.outcome(id, journalStatus(reply.status), reply.result, reply.jobId);
      } catch (error) {
        if (error instanceof ExecutorNotDispatchedError) deploymentJournal.outcome(id, 'failed', 'Magnus executor credential unavailable; nothing was dispatched');
        else deploymentJournal.outcome(id, 'unknown', 'Original dispatch may have started; reconcile its exact Magnus job without replay');
      } finally {
        active = null;
      }
    })();
  }, 1000);
  timer.unref();
  return async () => { clearInterval(timer); await active; };
}
