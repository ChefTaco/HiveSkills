import { createPrivateKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { rawPublicKey } from '../scripts/archive-utils.mjs';
import { entrySigningMessage, headSigningMessage, logKeyId } from '../scripts/transparency-log.mjs';

/** The registry's transparency log key: it signs every log entry and the log head. */
export type LogKey = { keyId: string; publicKey: string; privateKey: KeyObject };

let cached: { file: string; key: LogKey } | undefined;

/**
 * Load the log key from `file`, creating it (Ed25519, PKCS#8 PEM, mode 0600, never overwritten) when
 * it does not exist yet. An existing key readable by group or others is refused. The private key never
 * leaves this process; only the public key is served.
 */
export function logKey(file: string): LogKey {
  if (cached?.file === file) return cached.key;
  let pem: string;
  try {
    // A key others on the host can read is no longer the registry's alone: refuse it.
    if ((statSync(file).mode & 0o077) !== 0) throw new Error(`The transparency log key ${file} is readable by group or others; restrict it to the service account (chmod 600)`);
    pem = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const { privateKey } = generateKeyPairSync('ed25519');
    try {
      writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    } catch (writeError) {
      // Another process created it first: use that one.
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
    }
    pem = readFileSync(file, 'utf8');
  }
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The transparency log key must be an Ed25519 private key');
  const publicKey = rawPublicKey(privateKey);
  const key = { keyId: logKeyId(publicKey), publicKey, privateKey };
  cached = { file, key };
  return key;
}

export const signEntry = (key: LogKey, index: number, hash: string): string =>
  sign(null, entrySigningMessage(index, hash), key.privateKey).toString('base64url');

export const signHead = (key: LogKey, size: number, headHash: string, signedAt: string): string =>
  sign(null, headSigningMessage(size, headHash, signedAt, key.keyId), key.privateKey).toString('base64url');
