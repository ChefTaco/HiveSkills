#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { boundedResponse, extractArchive, keyRevocation, MAX_ARCHIVE_BYTES, MAX_REVOCATION_PAYLOAD_BYTES, parsePublisherKeys, releaseRevocation, verifyReleaseSignature, verifyRevocationList } from './archive-utils.mjs';

const safeSlug = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{1,62}$/.test(value);
const versionParts = (value) => { const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(String(value)); return match ? match.slice(1).map(Number) : null; };
const compareVersions = (left, right) => { const a = versionParts(left); const b = versionParts(right); if (!a || !b) throw new Error('Invalid Hermes compatibility version'); for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index]; return 0; };
const compatibleVersion = (version, range = {}) => (!range.minHermesVersion && !range.maxHermesVersion) || Boolean(version && (!range.minHermesVersion || compareVersions(version, range.minHermesVersion) >= 0) && (!range.maxHermesVersion || compareVersions(version, range.maxHermesVersion) <= 0));
function detectHermesVersion() {
  if (process.env.HIVE_SKILLS_HERMES_VERSION) return process.env.HIVE_SKILLS_HERMES_VERSION;
  const command = process.env.HERMES_BIN ?? 'hermes';
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 ? (String(result.stdout).match(/v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] ?? undefined) : undefined;
}
function atomicJson(path, value) {
  const fd = openSync(path + '.tmp', 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(path + '.tmp', path);
  const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
}

const settleDelay = (raw) => { const value = Number(raw); return raw !== undefined && raw !== '' && Number.isSafeInteger(value) && value >= 0 && value <= 300_000 ? value : 10_000; };

/**
 * Restart the Hermes gateway and check it stays up. `try-restart` exiting 0 proves only that systemd
 * accepted the job, so when the gateway was running before, it must still be active after a settle
 * delay (HIVE_SKILLS_RESTART_SETTLE_MS, default 10000) without systemd having restarted it again.
 * A gateway that was not running is left stopped, as before.
 */
export async function restartGateway({ run = spawnSync, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), settleMs = settleDelay(process.env.HIVE_SKILLS_RESTART_SETTLE_MS), unit = 'hermes-gateway.service' } = {}) {
  const systemctl = (...args) => run('/usr/bin/systemctl', ['--user', ...args, unit], { encoding: 'utf8', timeout: 30_000 });
  const restarts = () => { const value = Number(String(systemctl('show', '-p', 'NRestarts', '--value').stdout ?? '').trim()); return Number.isSafeInteger(value) ? value : null; };
  const wasActive = systemctl('is-active', '--quiet').status === 0;
  if (systemctl('try-restart').status !== 0) throw new Error('Hermes gateway restart failed');
  if (!wasActive) return;
  const before = restarts();
  await sleep(settleMs);
  if (systemctl('is-active', '--quiet').status !== 0) throw new Error('Hermes gateway is not running after the restart');
  const afterwards = restarts();
  if (before !== null && afterwards !== null && afterwards > before) throw new Error('Hermes gateway restarted again after the restart');
}

export async function syncSkills({ registry, hermesHome = resolve(homedir(), '.hermes'), fetchImpl = fetch, target, token, frozenManifest, publisherKeys = new Map(), unsignedInstalled = 'report', revocationKeys = new Map(), revokedInstalled = 'quarantine', now = () => Date.now(), hermesVersion = detectHermesVersion(), checkpoint = () => {}, restart = () => restartGateway() }) {
  if (unsignedInstalled !== 'report' && unsignedInstalled !== 'quarantine') throw new Error('HIVE_SKILLS_UNSIGNED_INSTALLED must be report or quarantine');
  if (revokedInstalled !== 'report' && revokedInstalled !== 'quarantine') throw new Error('HIVE_SKILLS_REVOKED_INSTALLED must be quarantine or report');
  const origin = new URL(registry);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) throw new Error('Registry requires a plain HTTPS URL');
  // A frozen approval never bypasses native target revocation or a changed
  // assignment. Authorize before touching profile state, then consume only the
  // exact approved immutable publication (timestamps are not publication pins).
  if (frozenManifest && target) {
    if (!token) throw new Error('Target token required');
    const authorizedUrl = new URL(origin.href.replace(/\/$/, '') + '/v1/agent/manifest');
    authorizedUrl.searchParams.set('target', target);
    if (hermesVersion) authorizedUrl.searchParams.set('hermes_version', hermesVersion);
    const authorized = JSON.parse((await boundedResponse(await fetchImpl(authorizedUrl, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) }), 1024 * 1024)).toString('utf8'));
    const publication = value => JSON.stringify({ schemaVersion: value.schemaVersion, channel: value.channel ?? 'stable', skills: value.skills });
    if (publication(authorized) !== publication(frozenManifest)) throw new Error('Approved publication differs from the current authorized target assignment; prepare a new review');
  }
  const root = resolve(hermesHome, 'skills', 'registry');
  const control = resolve(hermesHome, '.hive-skills-sync');
  const statePath = resolve(root, '.hive-skills-state.json');
  const transactionPath = resolve(control, 'transaction.json');
  const lockPath = resolve(control, 'lock');
  mkdirSync(root, { recursive: true, mode: 0o700 }); mkdirSync(control, { recursive: true, mode: 0o700 });
  try { mkdirSync(lockPath, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pidPath = resolve(lockPath, 'pid');
    if (!existsSync(pidPath) && Date.now() - statSync(lockPath).mtimeMs < 60_000) throw new Error('Skills sync lock is being initialized');
    const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8')) : 2147483647;
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid sync lock');
    try { process.kill(pid, 0); throw new Error('Skills sync already running'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    rmSync(lockPath, { recursive: true }); mkdirSync(lockPath, { mode: 0o700 });
  }
  writeFileSync(resolve(lockPath, 'pid'), String(process.pid), { mode: 0o600 });
  try {
    // Resume a rename interrupted before state publication. No remote content
    // is needed to restore the previous complete directory.
    if (existsSync(transactionPath)) {
      const transaction = JSON.parse(readFileSync(transactionPath, 'utf8'));
      if (!safeSlug(transaction.slug)) throw new Error('Invalid sync transaction');
      const destination = resolve(root, transaction.slug);
      const backup = resolve(control, transaction.slug + '.previous');
      const staging = resolve(control, transaction.slug + '.incoming');
      if (!existsSync(staging) && existsSync(destination) && transaction.nextState) atomicJson(statePath, transaction.nextState);
      else if (!existsSync(destination) && existsSync(backup)) renameSync(backup, destination);
      rmSync(transactionPath);
    }
    const prior = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { skills: {} };
    if (prior.registry && prior.registry !== origin.href) throw new Error('This profile belongs to a different registry; migrate explicitly');
    const manifestUrl = new URL(origin.href.replace(/\/$/, '') + '/v1/agent/manifest');
    if (target) { if (!token) throw new Error('Target token required'); manifestUrl.searchParams.set('target', target); }
    if (hermesVersion) { if (!versionParts(hermesVersion)) throw new Error('Invalid local Hermes version'); manifestUrl.searchParams.set('hermes_version', hermesVersion); }
    const manifest = frozenManifest ?? JSON.parse((await boundedResponse(await fetchImpl(manifestUrl, { ...(target ? { headers: { authorization: `Bearer ${token}` } } : {}), redirect: 'error', signal: AbortSignal.timeout(20_000) }), 1024 * 1024)).toString('utf8'));
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.skills) || manifest.skills.length > 1000) throw new Error('Unsupported manifest');
    const channel = manifest.channel ?? 'stable';
    if (channel !== 'stable' && channel !== 'canary') throw new Error('Unsupported manifest channel');
    const desired = new Set();
    for (const skill of manifest.skills) {
      if (!safeSlug(skill.slug) || desired.has(skill.slug) || !/^[a-f0-9]{64}$/.test(skill.sha256) || !/^v?\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(skill.version)) throw new Error('Unsafe manifest entry');
      if (!compatibleVersion(hermesVersion, skill.compatibility)) throw new Error(`Skill ${skill.slug} is incompatible with this Hermes runtime`);
      const archiveUrl = new URL(skill.archiveUrl);
      const expected = new URL(origin.href.replace(/\/$/, '') + `/v1/skills/${skill.slug}/releases/${skill.version}/archive`);
      if (channel !== 'stable') expected.searchParams.set('channel', channel);
      if (archiveUrl.href !== expected.href) throw new Error('Unexpected archive origin or path');
      desired.add(skill.slug);
    }
    const needsInstall = (skill) => !(prior.skills?.[skill.slug]?.sha256 === skill.sha256 && existsSync(resolve(root, skill.slug, 'SKILL.md')));
    const postReceipt = async (body) => {
      atomicJson(resolve(control, 'receipt.json'), { registry: origin.href, completedAt: new Date().toISOString(), ...body });
      if (!target) return;
      const receipt = await fetchImpl(new URL(origin.href.replace(/\/$/, '') + '/v1/agent/receipts/' + encodeURIComponent(target)), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!receipt.ok) throw new Error('Fleet receipt upload failed');
    };
    // With pinned revocation keys, the registry's signed revocation list is read and verified on every
    // run (the sync timer makes that periodic), before anything is activated. A missing, unverifiable,
    // older or expired list fails the sync closed. The highest sequence seen is kept in the state file,
    // so the registry cannot roll the list back. A revoked release, or one signed only by a revoked
    // publisher key, is refused; installed ones are quarantined (HIVE_SKILLS_REVOKED_INSTALLED=report
    // only reports them) and the registry is told in a `revoked` receipt.
    let revocations = null;
    if (revocationKeys.size) {
      if (!target || !token) throw new Error('Pinned revocation keys need an enrolled target to read the revocation list');
      const url = new URL(origin.href.replace(/\/$/, '') + '/v1/revocations');
      url.searchParams.set('target', target);
      const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (response.status === 404) throw new Error('The registry serves no revocation list; publish one before pinning revocation keys');
      const served = JSON.parse((await boundedResponse(response, 2 * MAX_REVOCATION_PAYLOAD_BYTES + 64 * 1024)).toString('utf8'));
      revocations = verifyRevocationList(revocationKeys, served);
      const payloadSha256 = createHash('sha256').update(served.payload).digest('hex');
      const seen = prior.revocations;
      if (seen && revocations.sequence < seen.sequence) throw new Error(`The registry served revocation list ${revocations.sequence}, older than list ${seen.sequence} seen before`);
      if (seen && revocations.sequence === seen.sequence && payloadSha256 !== seen.payloadSha256) throw new Error(`The registry served a different revocation list ${revocations.sequence} than the one seen before`);
      if (revocations.expiresAt !== null && Date.parse(revocations.expiresAt) <= now()) throw new Error(`Revocation list ${revocations.sequence} expired at ${revocations.expiresAt}; the revocation authority must publish a fresh one`);
      if (!seen || seen.sequence !== revocations.sequence) {
        prior.revocations = { sequence: revocations.sequence, payloadSha256, issuedAt: revocations.issuedAt };
        atomicJson(statePath, { ...prior, registry: origin.href });
      }
    }
    // Findings about revoked releases and keys: {slug, version, reason, keyId?, install, why}.
    const revoked = [];
    if (revocations) for (const skill of manifest.skills) {
      const entry = releaseRevocation(revocations, skill.slug, skill.version);
      if (entry) revoked.push({ slug: skill.slug, version: skill.version, reason: 'release', install: needsInstall(skill), why: entry.reason });
    }
    const isRevoked = (slug) => revoked.some((entry) => entry.slug === slug);
    // With pinned publisher keys, every release about to be installed must carry a valid signature
    // from one of them. All are checked before anything is activated, so a registry or an
    // administrator session cannot push code the publisher did not sign. Skills installed before the
    // keys were pinned are checked too (once per release and key, remembered in the state): an
    // unsigned one is reported, or with HIVE_SKILLS_UNSIGNED_INSTALLED=quarantine moved out of the
    // gateway's skills directory, so unsigned code stops running.
    const verifiedSignatures = {};
    const signatureFindings = { refused: [], unsigned: [] };
    if (publisherKeys.size) {
      if (!target || !token) throw new Error('Pinned publisher keys need an enrolled target to read release signatures');
      const keyStamp = (keyId) => { const key = publisherKeys.get(keyId); return key ? `${keyId}:${key.export({ format: 'jwk' }).x}` : undefined; };
      const revokedKey = (keyId) => keyRevocation(revocations, keyId, publisherKeys.get(keyId));
      const refused = []; const unsigned = [];
      for (const skill of manifest.skills) {
        if (isRevoked(skill.slug)) continue;
        const install = needsInstall(skill);
        const remembered = prior.verifiedSignatures?.[skill.slug];
        if (!install && remembered && remembered.sha256 === skill.sha256 && remembered.key === keyStamp(remembered.keyId) && !revokedKey(remembered.keyId)) { verifiedSignatures[skill.slug] = remembered; continue; }
        const url = new URL(origin.href.replace(/\/$/, '') + `/v1/skills/${skill.slug}/releases/${skill.version}`);
        url.searchParams.set('target', target);
        const metadata = JSON.parse((await boundedResponse(await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) }), 64 * 1024)).toString('utf8'));
        if (metadata.slug !== skill.slug || metadata.version !== skill.version || metadata.sha256 !== skill.sha256) throw new Error(`Release metadata for ${skill.slug} differs from the manifest`);
        const signedBy = verifyReleaseSignature(publisherKeys, skill, metadata.signature) ? metadata.signature.keyId : null;
        const keyEntry = signedBy && revokedKey(signedBy);
        if (keyEntry) revoked.push({ slug: skill.slug, version: skill.version, reason: 'key', keyId: signedBy, install, why: keyEntry.reason });
        else if (signedBy) verifiedSignatures[skill.slug] = { sha256: skill.sha256, keyId: signedBy, key: keyStamp(signedBy) };
        else (install ? refused : unsigned).push(`${skill.slug} ${skill.version}`);
      }
      signatureFindings.refused = refused; signatureFindings.unsigned = unsigned;
    }
    const describe = (entry) => `${entry.slug} ${entry.version} (${entry.reason === 'key' ? `signing key ${entry.keyId} revoked` : 'release revoked'}: ${entry.why})`;
    const revokedInstalledSkills = revoked.filter((entry) => !entry.install);
    const quarantineUnsigned = unsignedInstalled === 'quarantine' ? signatureFindings.unsigned : [];
    const quarantineRevoked = revokedInstalled === 'quarantine' ? revokedInstalledSkills : [];
    const receiptRevocations = (action) => revoked.map((entry) => ({ slug: entry.slug, version: entry.version, reason: entry.reason, ...(entry.keyId ? { keyId: entry.keyId } : {}), action: entry.install ? 'refused' : action }));
    const reportRevoked = async (action) => {
      try { await postReceipt({ skills: prior.skills ?? {}, changed: [], status: 'revoked', revocations: receiptRevocations(action) }); }
      catch (error) { console.error('revoked receipt upload failed', error); }
    };
    if (quarantineUnsigned.length || quarantineRevoked.length) {
      for (const slug of [...quarantineUnsigned.map((entry) => entry.split(' ')[0]), ...quarantineRevoked.map((entry) => entry.slug)]) {
        const quarantine = resolve(control, slug + '.quarantined');
        rmSync(quarantine, { recursive: true, force: true });
        if (existsSync(resolve(root, slug))) renameSync(resolve(root, slug), quarantine);
        delete prior.skills[slug];
      }
      atomicJson(statePath, { ...prior, restartPending: true });
      await restart();
      atomicJson(statePath, { ...prior, restartPending: false });
      if (revoked.length) await reportRevoked('quarantined');
      const messages = [];
      if (quarantineRevoked.length) messages.push(`Quarantined installed skills whose release or signing key is revoked: ${quarantineRevoked.map(describe).join(', ')}`);
      if (quarantineUnsigned.length) messages.push(`Quarantined installed skills without a valid signature from a pinned publisher key: ${quarantineUnsigned.join(', ')}`);
      throw new Error(messages.join('; '));
    }
    if (signatureFindings.unsigned.length) console.warn(`Installed skills without a valid signature from a pinned publisher key stay active (set HIVE_SKILLS_UNSIGNED_INSTALLED=quarantine to remove them): ${signatureFindings.unsigned.join(', ')}`);
    if (revokedInstalledSkills.length) console.warn(`Installed skills whose release or signing key is revoked stay active because HIVE_SKILLS_REVOKED_INSTALLED=report: ${revokedInstalledSkills.map(describe).join(', ')}`);
    const revokedInstall = revoked.filter((entry) => entry.install);
    if (revokedInstall.length) {
      await reportRevoked('reported');
      throw new Error(`Refused revoked releases: ${revokedInstall.map(describe).join(', ')}`);
    }
    if (signatureFindings.refused.length) throw new Error(`Skill ${signatureFindings.refused.join(', ')} has no valid signature from a pinned publisher key`);
    // `pendingChanges` lists the skills installed since the gateway last restarted cleanly, carried
    // across runs while a restart is pending, so a failed restart is attributed to them only.
    const next = { registry: origin.href, skills: { ...prior.skills }, restartPending: prior.restartPending === true, pendingChanges: prior.restartPending === true && Array.isArray(prior.pendingChanges) ? prior.pendingChanges.filter(safeSlug) : [], ...(publisherKeys.size ? { verifiedSignatures } : {}), ...(prior.revocations ? { revocations: prior.revocations } : {}) };
    let changed = false;
    for (const skill of manifest.skills) {
      const destination = resolve(root, skill.slug);
      next.skills[skill.slug] = { version: skill.version, sha256: skill.sha256 };
      if (!needsInstall(skill)) continue;
      if (existsSync(destination) && !prior.skills?.[skill.slug]) throw new Error("Refusing to replace an unmanaged skill");
      const bytes = await boundedResponse(await fetchImpl(skill.archiveUrl, { redirect: 'error', signal: AbortSignal.timeout(60_000) }), MAX_ARCHIVE_BYTES);
      if (createHash('sha256').update(bytes).digest('hex') !== skill.sha256) throw new Error('Archive checksum mismatch');
      const staging = resolve(control, skill.slug + '.incoming');
      const backup = resolve(control, skill.slug + '.previous');
      rmSync(staging, { recursive: true, force: true }); mkdirSync(staging, { mode: 0o700 });
      try { extractArchive(bytes, staging); } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
      if (!next.pendingChanges.includes(skill.slug)) next.pendingChanges.push(skill.slug);
      atomicJson(transactionPath, { slug: skill.slug, nextState: { ...next, restartPending: true } });
      checkpoint('prepared');
      rmSync(backup, { recursive: true, force: true });
      if (existsSync(destination)) renameSync(destination, backup);
      checkpoint('backed-up');
      renameSync(staging, destination);
      checkpoint('activated');
      next.restartPending = true; atomicJson(statePath, next);
      checkpoint('published');
      rmSync(transactionPath);
      changed = true;
    }
    for (const slug of Object.keys(prior.skills ?? {})) {
      if (!safeSlug(slug)) throw new Error('Invalid managed skill state');
      if (!desired.has(slug) && existsSync(resolve(root, slug))) {
        const backup = resolve(control, slug + '.withdrawn');
        rmSync(backup, { recursive: true, force: true }); renameSync(resolve(root, slug), backup); changed = true;
      }
    }
    for (const slug of Object.keys(next.skills)) if (!desired.has(slug)) delete next.skills[slug];
    next.pendingChanges = next.pendingChanges.filter((slug) => next.skills[slug]);
    next.restartPending ||= changed;
    atomicJson(statePath, next);
    // `changed` names the skills this activation installed; the registry's automatic canary rollback
    // acts only on those when the restart fails.
    // Revoked installed skills kept active (HIVE_SKILLS_REVOKED_INSTALLED=report) are named in the receipt.
    const report = (status, changes) => postReceipt({ skills: next.skills, changed: changes, status, ...(revoked.length ? { revocations: receiptRevocations('reported') } : {}) });
    const changes = [...next.pendingChanges];
    if (next.restartPending) {
      try { await restart(); }
      catch (error) {
        // Keep the restart pending for the next run and tell the registry, best effort: the restart
        // error is what the caller needs to see.
        try { await report('restart_failed', changes); } catch (reportError) { console.error('restart_failed receipt upload failed', reportError); }
        throw error;
      }
      next.restartPending = false; next.pendingChanges = []; atomicJson(statePath, next);
    }
    await report('activated', changes);
    return next;
  } finally { rmSync(lockPath, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await syncSkills({ registry: process.env.HIVE_SKILLS_URL, hermesHome: process.env.HERMES_HOME, target: process.env.HIVE_SKILLS_TARGET, token: process.env.HIVE_SKILLS_TARGET_TOKEN, frozenManifest: process.env.HIVE_SKILLS_FROZEN_MANIFEST ? JSON.parse(process.env.HIVE_SKILLS_FROZEN_MANIFEST) : undefined, publisherKeys: parsePublisherKeys(process.env.HIVE_SKILLS_PUBLISHER_KEYS), unsignedInstalled: process.env.HIVE_SKILLS_UNSIGNED_INSTALLED || 'report', revocationKeys: parsePublisherKeys(process.env.HIVE_SKILLS_REVOCATION_KEYS), revokedInstalled: process.env.HIVE_SKILLS_REVOKED_INSTALLED || 'quarantine' });
}
