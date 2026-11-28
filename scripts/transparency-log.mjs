// The HiveSkills transparency log: an append-only, hash-chained record of release publications,
// release signatures and revocation lists. The registry writes it; anyone holding the log's public
// key can verify it end to end with `verifyTransparencyLog` (or scripts/verify-transparency-log.mjs).
//
// Each entry is the exact JSON string
//   {"v":1,"index":N,"previousHash":H,"kind":K,"recordedAt":ISO,"subject":{...}}
// whose hash is sha256("hiveskills-transparency-entry-v1\n" + entry). `previousHash` is the hash of
// entry N-1 (64 zeros for entry 0), so changing, dropping or reordering any entry breaks every later
// link. The registry's log key (Ed25519) signs "hiveskills-transparency-log-v1\n<index>\n<hash>\n"
// for every entry and "hiveskills-transparency-head-v1\n<size>\n<headHash>\n" for the head.
//
// Kinds and subjects:
//   release.published      {slug, version, sha256, signature: {keyId, value} | null[, backfilled: true]}
//   release.signed         {slug, version, sha256, signature: {keyId, value}}
//   revocations.published  {sequence, payloadSha256, payload, signature: {keyId, value}}
import { createHash, createPublicKey, verify } from 'node:crypto';
import { keyRevocation, releaseRevocation, verifyReleaseSignature, verifyRevocationList } from './archive-utils.mjs';

export const GENESIS_HASH = '0'.repeat(64);
export const LOG_KINDS = ['release.published', 'release.signed', 'revocations.published'];
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DIGEST = /^[a-f0-9]{64}$/;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const entryHash = (entry) => sha256(`hiveskills-transparency-entry-v1\n${entry}`);
export const entrySigningMessage = (index, hash) => Buffer.from(`hiveskills-transparency-log-v1\n${index}\n${hash}\n`, 'utf8');
export const headSigningMessage = (size, headHash) => Buffer.from(`hiveskills-transparency-head-v1\n${size}\n${headHash}\n`, 'utf8');
/** A log key's id: `log-` and the first 16 hex digits of the SHA-256 of its raw public key. */
export const logKeyId = (publicKey) => `log-${sha256(Buffer.from(publicKey, 'base64url')).slice(0, 16)}`;
/** A public key object from a base64url raw 32-byte Ed25519 key. */
export function ed25519PublicKey(publicKey) {
  const raw = typeof publicKey === 'string' && BASE64URL.test(publicKey) ? Buffer.from(publicKey, 'base64url') : Buffer.alloc(0);
  if (raw.length !== 32) throw new Error('A log key must be a base64url raw 32-byte Ed25519 public key');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

/** The exact entry string for these fields, in the fixed field order. */
export function buildEntry({ index, previousHash, kind, recordedAt, subject }) {
  if (!LOG_KINDS.includes(kind)) throw new Error(`Unknown transparency log entry kind ${kind}`);
  return JSON.stringify({ v: 1, index, previousHash, kind, recordedAt, subject });
}

const signatureValid = (key, message, value) => {
  if (typeof value !== 'string' || !BASE64URL.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  try { return bytes.length === 64 && verify(null, message, key, bytes); } catch { return false; }
};

/**
 * Verify a transparency log end to end. `entries` are the API's rows ({index, entry, hash, keyId,
 * signature}) from index 0 on; `head` is the signed head ({size, headHash, logKey: {keyId, publicKey},
 * signature}). `logKeys` (a Map of key id to public key, or a base64url key) is the log key you trust;
 * without it the head's own key is used (trust on first use, reported as a warning).
 *
 * With `publisherKeys` every release signature in the log is checked; with `revocationKeys` every
 * revocation list is. `knownHead` ({size, headHash}, from an earlier run) must be a prefix of this log.
 * Throws on the first broken link, bad signature, digest change or rollback; returns a summary.
 */
export function verifyTransparencyLog({ entries, head, logKeys, publisherKeys, revocationKeys, knownHead }) {
  if (!Array.isArray(entries)) throw new Error('Transparency log entries must be an array');
  if (!head || typeof head !== 'object' || !head.logKey || typeof head.logKey !== 'object') throw new Error('A signed log head is required');
  const warnings = [];
  let trusted;
  if (logKeys instanceof Map) trusted = logKeys;
  else if (typeof logKeys === 'string') trusted = new Map([[logKeyId(logKeys), ed25519PublicKey(logKeys)]]);
  else {
    trusted = new Map([[logKeyId(head.logKey.publicKey), ed25519PublicKey(head.logKey.publicKey)]]);
    warnings.push('No log key was pinned; the key the registry served was trusted for this run');
  }
  const releases = new Map();
  let previousHash = GENESIS_HASH, lastSequence = 0, revocations = null, releaseSignatures = 0, revocationLists = 0;
  entries.forEach((row, position) => {
    const where = `entry ${position}`;
    if (!row || typeof row !== 'object' || row.index !== position || typeof row.entry !== 'string') throw new Error(`${where}: missing or out of order`);
    const hash = entryHash(row.entry);
    if (row.hash !== hash) throw new Error(`${where}: hash does not match its content`);
    const key = trusted.get(row.keyId);
    if (!key) throw new Error(`${where}: signed by log key ${row.keyId}, which is not trusted`);
    if (!signatureValid(key, entrySigningMessage(position, hash), row.signature)) throw new Error(`${where}: log signature does not verify`);
    let entry;
    try { entry = JSON.parse(row.entry); } catch { throw new Error(`${where}: not JSON`); }
    if (buildEntry(entry) !== row.entry) throw new Error(`${where}: not in canonical form`);
    if (entry.v !== 1 || entry.index !== position) throw new Error(`${where}: wrong version or index`);
    if (entry.previousHash !== previousHash) throw new Error(`${where}: does not link to the previous entry`);
    if (typeof entry.recordedAt !== 'string' || !Number.isFinite(Date.parse(entry.recordedAt))) throw new Error(`${where}: invalid recordedAt`);
    const subject = entry.subject;
    if (!subject || typeof subject !== 'object') throw new Error(`${where}: missing subject`);
    if (entry.kind === 'release.published' || entry.kind === 'release.signed') {
      if (typeof subject.slug !== 'string' || typeof subject.version !== 'string' || !DIGEST.test(subject.sha256)) throw new Error(`${where}: invalid release`);
      const id = `${subject.slug}@${subject.version}`;
      const known = releases.get(id);
      if (entry.kind === 'release.published' && known) throw new Error(`${where}: ${id} was published twice`);
      if (entry.kind === 'release.signed' && !known) throw new Error(`${where}: ${id} was signed before it was published`);
      if (known && known !== subject.sha256) throw new Error(`${where}: ${id} changed its digest`);
      releases.set(id, subject.sha256);
      if (entry.kind === 'release.signed' && !subject.signature) throw new Error(`${where}: a signature entry without a signature`);
      if (subject.signature && publisherKeys?.size) {
        const signature = subject.signature;
        if (!publisherKeys.has(signature.keyId)) warnings.push(`${where}: ${id} is signed by ${signature.keyId}, which is not in the given publisher keys`);
        else if (!verifyReleaseSignature(publisherKeys, subject, signature)) throw new Error(`${where}: the publisher signature of ${id} does not verify`);
        else {
          releaseSignatures++;
          if (keyRevocation(revocations, signature.keyId, publisherKeys.get(signature.keyId))) warnings.push(`${where}: ${id} is signed by revoked key ${signature.keyId}`);
        }
      }
      if (entry.kind === 'release.published' && releaseRevocation(revocations, subject.slug, subject.version)) warnings.push(`${where}: ${id} was published after it was revoked`);
    } else if (entry.kind === 'revocations.published') {
      if (!Number.isSafeInteger(subject.sequence) || subject.sequence <= lastSequence) throw new Error(`${where}: revocation list sequence ${subject.sequence} does not increase`);
      if (typeof subject.payload !== 'string' || subject.payloadSha256 !== sha256(subject.payload)) throw new Error(`${where}: revocation payload digest does not match`);
      if (revocationKeys?.size) {
        let list;
        try { list = verifyRevocationList(revocationKeys, { payload: subject.payload, signature: subject.signature }); } catch (error) { throw new Error(`${where}: ${error instanceof Error ? error.message : 'invalid revocation list'}`); }
        if (list.sequence !== subject.sequence) throw new Error(`${where}: revocation list sequence differs from its entry`);
        revocations = list;
      } else {
        try { revocations = JSON.parse(subject.payload); } catch { throw new Error(`${where}: revocation payload is not JSON`); }
      }
      lastSequence = subject.sequence;
      revocationLists++;
    } else throw new Error(`${where}: unknown kind ${entry.kind}`);
    previousHash = hash;
  });
  if (head.size !== entries.length) throw new Error(`The head names ${head.size} entries but ${entries.length} were read`);
  if (head.headHash !== previousHash) throw new Error('The head hash does not match the last entry');
  const headKey = trusted.get(head.logKey.keyId);
  if (!headKey || head.logKey.keyId !== logKeyId(head.logKey.publicKey)) throw new Error(`The head is signed by log key ${head.logKey.keyId}, which is not trusted`);
  if (!signatureValid(headKey, headSigningMessage(head.size, head.headHash), head.signature)) throw new Error('The head signature does not verify');
  if (knownHead) {
    if (!Number.isSafeInteger(knownHead.size) || knownHead.size > entries.length) throw new Error(`The log shrank: ${entries.length} entries, but ${knownHead.size} were seen before`);
    const expected = knownHead.size === 0 ? GENESIS_HASH : entries[knownHead.size - 1].hash;
    if (expected !== knownHead.headHash) throw new Error(`The log was rewritten: entry ${knownHead.size - 1} differs from the head seen before`);
  }
  return { size: entries.length, headHash: previousHash, releases: releases.size, releaseSignatures, revocationLists, revocationSequence: lastSequence, warnings };
}
