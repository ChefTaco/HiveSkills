import { createPublicKey, verify } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
export function readArchive(bytes) {
  if (!bytes.length || bytes.length > MAX_ARCHIVE_BYTES) throw new Error('Archive exceeds compressed size limit');
  const tar = gunzipSync(bytes, { maxOutputLength: 100 * 1024 * 1024 });
  const entries = [];
  const names = new Set();
  const field = (block, start, length) => block.subarray(start, start + length).toString('utf8').split('\0')[0];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const checksum = [...block].reduce((total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (checksum !== Number.parseInt(field(block, 148, 8).trim(), 8)) throw new Error('Invalid tar checksum');
    const rawSize = field(block, 124, 12).trim();
    if (!/^[0-7]+$/.test(rawSize)) throw new Error('Invalid tar size');
    const size = Number.parseInt(rawSize, 8);
    const type = field(block, 156, 1);
    if (!['', '0', '5'].includes(type)) throw new Error('Only regular files and directories are allowed');
    const prefix = field(block, 345, 155);
    let name = (prefix ? prefix + '/' : '') + field(block, 0, 100);
    name = name.replace(/^(\.\/)+/, '').replace(/\/$/, '');
    offset += 512;
    if (size > 10 * 1024 * 1024 || offset + size > tar.length || type === '5' && size !== 0) throw new Error('Invalid or excessive unpacked file size');
    if (name) {
      if (name.startsWith('/') || name.includes('\\') || /[\x00-\x1f\x7f]/.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..') || names.has(name)) throw new Error('Unsafe or duplicate archive path');
      names.add(name);
      entries.push({ name, directory: type === '5', bytes: tar.subarray(offset, offset + size) });
      if (entries.length > 2000) throw new Error('Archive has too many entries');
    }
    offset += Math.ceil(size / 512) * 512;
  }
  if (!entries.some((entry) => entry.name === 'SKILL.md' && !entry.directory && entry.bytes.length > 0)) throw new Error('Archive must have a root SKILL.md');
  for (const entry of entries) {
    const parts = entry.name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const parent = entries.find((candidate) => candidate.name === parts.slice(0, i).join('/'));
      if (parent && !parent.directory) throw new Error('Archive file overlaps a directory');
    }
  }
  return entries;
}

export function extractArchive(bytes, destination) {
  const entries = readArchive(bytes); // Validate the entire archive before any write.
  for (const entry of entries) {
    const path = resolve(destination, entry.name);
    mkdirSync(entry.directory ? path : dirname(path), { recursive: true, mode: 0o700 });
    if (!entry.directory) writeFileSync(path, entry.bytes, { mode: 0o600, flag: 'wx' });
  }
}

export async function boundedResponse(response, limit) {
  if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Response exceeds size limit');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing response body');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Response exceeds size limit');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

// Publisher-signed releases. A publisher signs (Ed25519) this exact message for each release, so a
// registry or an administrator session cannot change what a pinned key vouches for. Shared by the
// registry, which checks a signature at upload, and the bridge, which checks it before activation.
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
export function releaseSigningMessage(slug, version, sha256) {
  return Buffer.from(`hiveskills-release-signature-v1\n${slug}\n${version}\n${sha256}\n`, 'utf8');
}

/**
 * Pinned publisher keys from JSON: `[{"keyId":"...","publicKey":"<base64url raw 32-byte Ed25519>"}]`.
 * Empty or unset means no keys. Malformed input throws, so a typo never silently disables checks.
 */
export function parsePublisherKeys(value) {
  const keys = new Map();
  if (value === undefined || value === null || String(value).trim() === '') return keys;
  let entries;
  try { entries = JSON.parse(String(value)); } catch { throw new Error('Publisher keys must be a JSON array'); }
  if (!Array.isArray(entries) || entries.length > 32) throw new Error('Publisher keys must be a JSON array of at most 32 keys');
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'keyId,publicKey') throw new Error('Each publisher key needs exactly keyId and publicKey');
    if (typeof entry.keyId !== 'string' || !KEY_ID.test(entry.keyId) || keys.has(entry.keyId)) throw new Error('Publisher key ids must be unique and match [A-Za-z0-9._-]{1,64}');
    const raw = typeof entry.publicKey === 'string' && BASE64URL.test(entry.publicKey) ? Buffer.from(entry.publicKey, 'base64url') : Buffer.alloc(0);
    if (raw.length !== 32) throw new Error(`Publisher key ${entry.keyId} must be a base64url raw 32-byte Ed25519 public key`);
    keys.set(entry.keyId, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' }));
  }
  return keys;
}

/** True when `signature` ({keyId, value}) is a valid signature of this release by a pinned key. */
export function verifyReleaseSignature(keys, release, signature) {
  if (!signature || typeof signature !== 'object' || typeof signature.keyId !== 'string' || typeof signature.value !== 'string') return false;
  const key = keys.get(signature.keyId);
  if (!key || !BASE64URL.test(signature.value)) return false;
  const bytes = Buffer.from(signature.value, 'base64url');
  if (bytes.length !== 64) return false;
  try { return verify(null, releaseSigningMessage(release.slug, release.version, release.sha256), key, bytes); } catch { return false; }
}

// Signed revocation lists. A revocation authority, whose Ed25519 keys are pinned separately from the
// publisher keys (HIVE_SKILLS_REVOCATION_KEYS), signs the exact payload string; the registry serves
// it unchanged and the bridge verifies it before activation. The payload is JSON:
//   {"schema":"hiveskills-revocations-v1","sequence":N,"issuedAt":ISO,"expiresAt":ISO|null,
//    "keys":[{"keyId","publicKey","reason","revokedAt"}],
//    "releases":[{"slug","version","sha256","reason","revokedAt"}]}
// `sequence` only ever grows, so a registry cannot serve an older list once a newer one was seen.
export const REVOCATIONS_SCHEMA = 'hiveskills-revocations-v1';
export const MAX_REVOKED_KEYS = 256;
export const MAX_REVOKED_RELEASES = 2000;
/** The largest payload a list may have; the registry and the bridge refuse anything bigger. */
export const MAX_REVOCATION_PAYLOAD_BYTES = 384 * 1024;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const RELEASE_VERSION = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DIGEST = /^[a-f0-9]{64}$/;

export function revocationSigningMessage(payload) {
  return Buffer.from(`hiveskills-revocation-list-v1\n${payload}`, 'utf8');
}

/** The base64url raw 32-byte Ed25519 public key of a key object. */
export const rawPublicKey = (key) => key.export({ format: 'jwk' }).x;

const exactKeys = (value, keys, what) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error(`${what} must have exactly ${keys.join(', ')}`);
};
const isoTime = (value, what) => {
  if (typeof value !== 'string' || !ISO_TIME.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${what} must be an ISO 8601 UTC time`);
  return value;
};
const reasonText = (value, what) => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 500 || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${what} needs a reason of at most 500 characters`);
  return value;
};

/** Validate a revocation payload string and return the parsed list. Anything unexpected throws. */
export function parseRevocationPayload(payload) {
  if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > MAX_REVOCATION_PAYLOAD_BYTES) throw new Error('Revocation payload must be a string of at most 384 KiB');
  let list;
  try { list = JSON.parse(payload); } catch { throw new Error('Revocation payload must be JSON'); }
  exactKeys(list, ['schema', 'sequence', 'issuedAt', 'expiresAt', 'keys', 'releases'], 'A revocation list');
  if (list.schema !== REVOCATIONS_SCHEMA) throw new Error(`Revocation list schema must be ${REVOCATIONS_SCHEMA}`);
  if (!Number.isSafeInteger(list.sequence) || list.sequence < 1) throw new Error('Revocation list sequence must be a positive integer');
  isoTime(list.issuedAt, 'issuedAt');
  if (list.expiresAt !== null) { isoTime(list.expiresAt, 'expiresAt'); if (Date.parse(list.expiresAt) <= Date.parse(list.issuedAt)) throw new Error('expiresAt must be after issuedAt'); }
  if (!Array.isArray(list.keys) || list.keys.length > MAX_REVOKED_KEYS) throw new Error(`Revocation list keys must be an array of at most ${MAX_REVOKED_KEYS}`);
  if (!Array.isArray(list.releases) || list.releases.length > MAX_REVOKED_RELEASES) throw new Error(`Revocation list releases must be an array of at most ${MAX_REVOKED_RELEASES}`);
  const seenKeys = new Set();
  for (const entry of list.keys) {
    exactKeys(entry, ['keyId', 'publicKey', 'reason', 'revokedAt'], 'A revoked key');
    if (typeof entry.keyId !== 'string' || !KEY_ID.test(entry.keyId)) throw new Error('A revoked key id must match [A-Za-z0-9._-]{1,64}');
    if (typeof entry.publicKey !== 'string' || !BASE64URL.test(entry.publicKey) || Buffer.from(entry.publicKey, 'base64url').length !== 32) throw new Error(`Revoked key ${entry.keyId} must be a base64url raw 32-byte Ed25519 public key`);
    const identity = `${entry.keyId}:${entry.publicKey}`;
    if (seenKeys.has(identity)) throw new Error(`Key ${entry.keyId} is revoked twice`);
    seenKeys.add(identity);
    reasonText(entry.reason, `Revoked key ${entry.keyId}`); isoTime(entry.revokedAt, 'revokedAt');
  }
  const seenReleases = new Set();
  for (const entry of list.releases) {
    exactKeys(entry, ['slug', 'version', 'sha256', 'reason', 'revokedAt'], 'A revoked release');
    if (typeof entry.slug !== 'string' || !SLUG.test(entry.slug) || typeof entry.version !== 'string' || !RELEASE_VERSION.test(entry.version) || typeof entry.sha256 !== 'string' || !DIGEST.test(entry.sha256)) throw new Error('A revoked release needs a valid slug, version and sha256');
    const identity = `${entry.slug}@${entry.version}`;
    if (seenReleases.has(identity)) throw new Error(`Release ${identity} is revoked twice`);
    seenReleases.add(identity);
    reasonText(entry.reason, `Revoked release ${identity}`); isoTime(entry.revokedAt, 'revokedAt');
  }
  return list;
}

/**
 * Verify a signed revocation list (`{payload, signature: {keyId, value}}`) against pinned revocation
 * keys and return the parsed list. Throws when the signature, the key or the payload is not valid.
 */
export function verifyRevocationList(keys, envelope) {
  if (!envelope || typeof envelope !== 'object' || typeof envelope.payload !== 'string') throw new Error('A signed revocation list needs a payload string');
  const signature = envelope.signature;
  if (!signature || typeof signature !== 'object' || typeof signature.keyId !== 'string' || typeof signature.value !== 'string') throw new Error('A signed revocation list needs a signature {keyId, value}');
  const key = keys.get(signature.keyId);
  if (!key) throw new Error(`Revocation list is signed by ${signature.keyId}, which is not a pinned revocation key`);
  const bytes = BASE64URL.test(signature.value) ? Buffer.from(signature.value, 'base64url') : Buffer.alloc(0);
  let valid = false;
  try { valid = bytes.length === 64 && verify(null, revocationSigningMessage(envelope.payload), key, bytes); } catch { valid = false; }
  if (!valid) throw new Error('Revocation list signature does not verify');
  return parseRevocationPayload(envelope.payload);
}

/** The revoked-key entry for this key id and key, if the list revokes it. */
export function keyRevocation(list, keyId, key) {
  if (!list || !key) return undefined;
  const publicKey = typeof key === 'string' ? key : rawPublicKey(key);
  return list.keys.find((entry) => entry.keyId === keyId && entry.publicKey === publicKey);
}

/** The revoked-release entry for this exact release, if the list revokes it (any digest). */
export function releaseRevocation(list, slug, version) {
  return list?.releases.find((entry) => entry.slug === slug && entry.version === version);
}
