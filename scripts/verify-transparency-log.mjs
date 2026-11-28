#!/usr/bin/env node
// Verify the HiveSkills transparency log end to end: every hash link, every log signature, the signed
// head and, when keys are given, every publisher signature and revocation list in it.
//
//   HIVE_SKILLS_TARGET=agent-1 HIVE_SKILLS_TARGET_TOKEN_FILE=~/.config/hive-skills/target-token \
//     node scripts/verify-transparency-log.mjs --registry https://skills.example.com \
//       --log-key <base64url> [--log-key <older key>] [--publisher-keys JSON] [--revocation-keys JSON] \
//       [--known-head SIZE:HASH] [--page-size N] [--save log.json]
//   node scripts/verify-transparency-log.mjs --file log.json --log-key <base64url>
//
// Reading the log needs an enrolled target (HIVE_SKILLS_TARGET with HIVE_SKILLS_TARGET_TOKEN or
// HIVE_SKILLS_TARGET_TOKEN_FILE) or a registry administrator's bearer token (HIVE_SKILLS_BEARER_FILE).
// Tokens are read from the environment or files and never printed. Prints a JSON summary; exits 1 on
// any failure. Pass the printed `size:headHash` as --known-head next time to detect a rewritten log.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { boundedResponse, parsePublisherKeys } from './archive-utils.mjs';
import { ed25519PublicKey, logKeyId, verifyTransparencyLog } from './transparency-log.mjs';

/** Entries per request (1 to 500); the registry also ends a page early past 4 MiB of entries. */
export const DEFAULT_PAGE_SIZE = 100;

/**
 * Read the signed head, every entry it covers and the payload of every revocation list the log
 * records (from GET /v1/revocations/<sequence>), as {head, entries, revocationPayloads}.
 */
export async function fetchTransparencyLog({ registry, target, token, bearer, fetchImpl = fetch, pageSize = DEFAULT_PAGE_SIZE }) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('The page size must be 1 to 500');
  const origin = new URL(registry);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) throw new Error('The registry needs a plain HTTPS URL');
  const base = origin.href.replace(/\/$/, '');
  const headers = bearer ? { authorization: `Bearer ${bearer}` } : token ? { authorization: `Bearer ${token}` } : {};
  const read = async (path, params = {}) => {
    const url = new URL(base + path);
    if (target && !bearer) url.searchParams.set('target', target);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
    return JSON.parse((await boundedResponse(await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) }), 16 * 1024 * 1024)).toString('utf8'));
  };
  const head = await read('/v1/transparency/head');
  const entries = [];
  while (entries.length < head.size) {
    const page = await read('/v1/transparency/entries', { from: entries.length, limit: pageSize });
    if (!Array.isArray(page.entries) || page.entries.length === 0) throw new Error('The registry stopped serving entries before the head');
    entries.push(...page.entries.slice(0, head.size - entries.length));
  }
  const revocationPayloads = {};
  for (const row of entries) {
    let entry;
    try { entry = JSON.parse(row.entry); } catch { continue; } // The verifier reports it.
    if (entry?.kind !== 'revocations.published' || !Number.isSafeInteger(entry.subject?.sequence)) continue;
    revocationPayloads[entry.subject.sequence] = (await read(`/v1/revocations/${entry.subject.sequence}`)).payload;
  }
  return { head, entries, revocationPayloads };
}

function options(args) {
  const result = { 'log-key': [] };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!name?.startsWith('--') || args[index + 1] === undefined) throw new Error(`Unexpected argument ${name ?? ''}`);
    const key = name.slice(2);
    if (key === 'log-key') result[key].push(args[index + 1]);
    else result[key] = args[index + 1];
  }
  return result;
}

const secret = (value, file) => value || (file ? readFileSync(file, 'utf8').trim() : undefined);

export async function main(argv, env = process.env, fetchImpl = fetch) {
  const given = options(argv);
  const known = new Set(['registry', 'file', 'log-key', 'publisher-keys', 'revocation-keys', 'known-head', 'page-size', 'save']);
  for (const name of Object.keys(given)) if (!known.has(name)) throw new Error(`Unknown option --${name}`);
  if (!given.registry === !given.file) throw new Error('Pass exactly one of --registry URL or --file FILE');
  const dump = given.file
    ? JSON.parse(readFileSync(given.file, 'utf8'))
    : await fetchTransparencyLog({ registry: given.registry, target: env.HIVE_SKILLS_TARGET, token: secret(env.HIVE_SKILLS_TARGET_TOKEN, env.HIVE_SKILLS_TARGET_TOKEN_FILE), bearer: secret(undefined, env.HIVE_SKILLS_BEARER_FILE), fetchImpl, pageSize: given['page-size'] === undefined ? DEFAULT_PAGE_SIZE : Number(given['page-size']) });
  if (given.save) writeFileSync(given.save, JSON.stringify(dump, null, 2) + '\n', { mode: 0o600 });
  const logKeys = given['log-key'].length ? new Map(given['log-key'].map((key) => [logKeyId(key), ed25519PublicKey(key)])) : undefined;
  let knownHead;
  if (given['known-head']) {
    const match = /^(\d+):([a-f0-9]{64})$/.exec(given['known-head']);
    if (!match) throw new Error('--known-head must be SIZE:HASH');
    knownHead = { size: Number(match[1]), headHash: match[2] };
  }
  return verifyTransparencyLog({
    entries: dump.entries, head: dump.head, logKeys,
    publisherKeys: parsePublisherKeys(given['publisher-keys']),
    revocationKeys: parsePublisherKeys(given['revocation-keys']),
    revocationPayloads: new Map(Object.entries(dump.revocationPayloads ?? {}).map(([sequence, payload]) => [Number(sequence), payload])),
    knownHead,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const summary = await main(process.argv.slice(2));
    console.log(JSON.stringify({ ok: true, ...summary, knownHead: `${summary.size}:${summary.headHash}` }));
  } catch (error) {
    console.error(`verify-transparency-log: ${error instanceof Error ? error.message : 'failed'}`);
    process.exitCode = 1;
  }
}
