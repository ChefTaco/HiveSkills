import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { store } from './db.js';
import type { AuthContext } from './types.js';

const cookieName = 'hive_skills_session';
const sign = (value: string): string => createHmac('sha256', config.sessionSecret).update(value).digest('base64url');
export const validUsername = (username: string): boolean => /^[a-z_][a-z0-9_-]{0,31}$/i.test(username);

export function createOsAuthenticator(spawnPam: typeof spawn = spawn, maxConcurrent = 4): (username: string, password: string) => Promise<boolean> {
  let activePam = 0;
  return async (username: string, password: string): Promise<boolean> => {
    if (!validUsername(username) || password.length === 0 || password.length > 1024 || activePam >= maxConcurrent) return false;
    activePam++;
    try {
      return await new Promise<boolean>((resolve) => {
        const child = spawnPam('/usr/bin/pamtester', [config.pamService, username, 'authenticate'], { stdio: ['pipe', 'ignore', 'ignore'], timeout: 10_000 });
        let settled = false;
        const finish = (result: boolean) => { if (!settled) { settled = true; resolve(result); } };
        child.on('error', () => finish(false));
        child.stdin.on('error', () => {});
        child.on('exit', (code) => finish(code === 0));
        child.stdin.end(password + '\n');
      });
    } finally { activePam--; }
  };
}

export const authenticateOsUser = createOsAuthenticator();

export const createSession = (username: string): string => {
  const id = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  store.createSession({ id, username, expiresAt });
  return `${id}.${sign(id)}`;
};

export const sessionCookie = (token: string, maxAge = 12 * 60 * 60): string =>
  `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

/** The session id from a cookie carrying this registry's signature; undefined otherwise. */
const sessionId = (cookieHeader: string | undefined): string | undefined => {
  const token = cookieHeader?.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!token) return undefined;
  const [id, signature, ...extra] = token.split('.');
  if (!id || !signature || extra.length > 0) return undefined;
  const expected = Buffer.from(sign(id));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? id : undefined;
};

export const readAuth = (cookieHeader: string | undefined): AuthContext | undefined => {
  const id = sessionId(cookieHeader);
  const session = id === undefined ? undefined : store.getSession(id);
  return session ? { username: session.username, isAdmin: config.adminUsers.has(session.username) } : undefined;
};

/** Revokes the signed, unexpired session in the cookie and returns its account; undefined when there is none. */
export const removeSession = (cookieHeader: string | undefined): string | undefined => {
  const id = sessionId(cookieHeader);
  const session = id === undefined ? undefined : store.getSession(id);
  if (session) store.deleteSession(session.id);
  return session?.username;
};
