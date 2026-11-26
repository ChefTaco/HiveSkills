#!/usr/bin/env node
// Publisher signing for HiveSkills releases (Ed25519). Run it where the private key lives, never on
// the registry host:
//
//   node scripts/sign-release.mjs keygen --out publisher.pem --key-id example-2026
//   node scripts/sign-release.mjs sign --key publisher.pem --key-id example-2026 --slug my-skill --version 1.0.0 --archive my-skill.tgz
//
// `keygen` writes a PKCS#8 private key (mode 0600, never overwritten) and prints the pinned-key entry
// for HIVE_SKILLS_PUBLISHER_KEYS. `sign` prints {"keyId","signature","sha256"} for the upload.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { releaseSigningMessage } from './archive-utils.mjs';

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!name?.startsWith('--') || args[index + 1] === undefined) throw new Error(`Unexpected argument ${name ?? ''}`);
    result[name.slice(2)] = args[index + 1];
  }
  return result;
}

const rawPublicKey = (key) => Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('base64url');

export function keygen({ out, keyId }) {
  if (!out || !keyId || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) throw new Error('keygen needs --out FILE and --key-id ID');
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(out, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
  return { keyId, publicKey: rawPublicKey(privateKey) };
}

export function signRelease({ key, keyId, slug, version, archive, sha256 }) {
  if (!key || !keyId || !slug || !version || (!archive && !sha256)) throw new Error('sign needs --key, --key-id, --slug, --version and --archive or --sha256');
  const digest = sha256 ?? createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid sha256');
  const privateKey = createPrivateKey(readFileSync(key));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The key must be an Ed25519 private key');
  return { keyId, signature: sign(null, releaseSigningMessage(slug, version, digest), privateKey).toString('base64url'), sha256: digest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...rest] = process.argv.slice(2);
    const given = options(rest);
    if (command === 'keygen') console.log(JSON.stringify(keygen({ out: given.out, keyId: given['key-id'] })));
    else if (command === 'sign') console.log(JSON.stringify(signRelease({ key: given.key, keyId: given['key-id'], slug: given.slug, version: given.version, archive: given.archive, sha256: given.sha256 })));
    else throw new Error('Use keygen or sign');
  } catch (error) {
    console.error(`sign-release: ${error instanceof Error ? error.message : 'failed'}`);
    process.exitCode = 1;
  }
}
