#!/usr/bin/env node
// Publisher signing for HiveSkills releases (Ed25519). Run it where the private key lives, never on
// the registry host:
//
//   node scripts/sign-release.mjs keygen --out publisher.pem --key-id example-2026
//   node scripts/sign-release.mjs sign --key publisher.pem --key-id example-2026 --slug my-skill --version 1.0.0 --archive my-skill.tgz
//   node scripts/sign-release.mjs sign-revocations --key revocations.pem --key-id revocations-2026 --list revocations.json
//
// `keygen` writes a PKCS#8 private key (mode 0600, never overwritten) and prints the pinned-key entry
// for HIVE_SKILLS_PUBLISHER_KEYS (or, for a revocation authority key, HIVE_SKILLS_REVOCATION_KEYS).
// `sign` prints {"keyId","signature","sha256"} for the upload. `sign-revocations` reads an unsigned
// list ({"sequence","expiresAt"?,"keys":[...],"releases":[...]}), completes it and prints the signed
// {"payload","signature"} for PUT /admin/revocations.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseRevocationPayload, releaseSigningMessage, REVOCATIONS_SCHEMA, revocationSigningMessage } from './archive-utils.mjs';

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

const ed25519Key = (file) => {
  const privateKey = createPrivateKey(readFileSync(file));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The key must be an Ed25519 private key');
  return privateKey;
};

/**
 * Sign a revocation list. `list` is the unsigned list ({sequence, expiresAt?, keys, releases}); the
 * schema and issuedAt (now, unless given) are filled in, and an entry without revokedAt gets issuedAt.
 * The payload is validated exactly as the registry and the bridge validate it.
 */
export function signRevocations({ key, keyId, list, now = new Date() }) {
  if (!key || !keyId || !KEY_ID_PATTERN.test(keyId) || !list) throw new Error('sign-revocations needs --key, --key-id and --list');
  const source = typeof list === 'string' ? JSON.parse(readFileSync(list, 'utf8')) : list;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('The revocation list must be a JSON object');
  const unknown = Object.keys(source).filter((name) => !['sequence', 'issuedAt', 'expiresAt', 'keys', 'releases'].includes(name));
  if (unknown.length) throw new Error(`Unknown revocation list fields: ${unknown.join(', ')}`);
  const issuedAt = source.issuedAt ?? now.toISOString();
  const stamp = (entry) => ({ ...entry, revokedAt: entry?.revokedAt ?? issuedAt });
  const payload = JSON.stringify({
    schema: REVOCATIONS_SCHEMA,
    sequence: source.sequence,
    issuedAt,
    expiresAt: source.expiresAt ?? null,
    keys: Array.isArray(source.keys) ? source.keys.map(stamp) : source.keys,
    releases: Array.isArray(source.releases) ? source.releases.map(stamp) : source.releases,
  });
  parseRevocationPayload(payload);
  return { payload, signature: { keyId, value: sign(null, revocationSigningMessage(payload), ed25519Key(key)).toString('base64url') } };
}
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, ...rest] = process.argv.slice(2);
    const given = options(rest);
    if (command === 'keygen') console.log(JSON.stringify(keygen({ out: given.out, keyId: given['key-id'] })));
    else if (command === 'sign') console.log(JSON.stringify(signRelease({ key: given.key, keyId: given['key-id'], slug: given.slug, version: given.version, archive: given.archive, sha256: given.sha256 })));
    else if (command === 'sign-revocations') console.log(JSON.stringify(signRevocations({ key: given.key, keyId: given['key-id'], list: given.list })));
    else throw new Error('Use keygen, sign or sign-revocations');
  } catch (error) {
    console.error(`sign-release: ${error instanceof Error ? error.message : 'failed'}`);
    process.exitCode = 1;
  }
}
