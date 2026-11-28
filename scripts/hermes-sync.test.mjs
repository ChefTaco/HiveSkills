import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readArchive, boundedResponse } from './archive-utils.mjs';
import { restartGateway, syncSkills } from './hermes-sync.mjs';
import { parsePublisherKeys } from './archive-utils.mjs';
import { keygen, signRelease } from './sign-release.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hive-skills-fixture-'));
  const source = join(root, 'source'); mkdirSync(source);
  writeFileSync(join(source, 'SKILL.md'), '# Fixture\n');
  const archive = join(root, 'skill.tgz');
  const pack = () => { assert.equal(spawnSync('tar', ['-czf', archive, '-C', source, '.']).status, 0); return readFileSync(archive); };
  return { root, source, pack };
}

test('rejects symlinks and validates skill root before extraction', () => {
  const f = fixture();
  try {
    assert.ok(readArchive(f.pack()).some((entry) => entry.name === 'SKILL.md'));
    symlinkSync('/etc/passwd', join(f.source, 'link'));
    assert.throws(() => readArchive(f.pack()), /regular files/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('size enforcement counts streamed bytes without trusting Content-Length', async () => {
  await assert.rejects(boundedResponse(new Response(new Uint8Array(1025)), 1024), /size limit/);
});

test('bridge declares its Hermes version and rejects incompatible server entries', async () => {
  const f = fixture();
  try {
    let requested;
    const entry = { slug: 'fixture', version: '1.0.0', sha256: 'a'.repeat(64), compatibility: { minHermesVersion: '3.0.0', maxHermesVersion: null }, archiveUrl: 'https://registry.test/v1/skills/fixture/releases/1.0.0/archive' };
    await assert.rejects(syncSkills({
      registry: 'https://registry.test', hermesHome: join(f.root, 'hermes'), hermesVersion: '2.4.0', restart: () => {},
      fetchImpl: async (url) => { requested = new URL(url); return Response.json({ schemaVersion: 1, skills: [entry] }); },
    }), /incompatible/);
    assert.equal(requested.searchParams.get('hermes_version'), '2.4.0');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('sync installs, withdraws only managed content and retries failed gateway restart', async () => {
  const f = fixture();
  try {
    const bytes = f.pack();
    const entry = { slug: 'fixture', version: '1.0.0', sha256: createHash('sha256').update(bytes).digest('hex'), archiveUrl: 'https://registry.test/v1/skills/fixture/releases/1.0.0/archive' };
    let skills = [entry]; let restarts = 0;
    const fetchImpl = async (url) => new URL(url).pathname.endsWith('/manifest') ? Response.json({ schemaVersion: 1, skills }) : new Response(bytes);
    const options = { registry: 'https://registry.test', hermesHome: join(f.root, 'hermes'), hermesVersion: '2.4.0', fetchImpl, restart: () => { restarts++; } };
    await syncSkills(options);
    assert.ok(existsSync(join(options.hermesHome, 'skills/registry/fixture/SKILL.md')));
    await syncSkills(options); assert.equal(restarts, 1);
    const local = join(options.hermesHome, 'skills/local'); mkdirSync(local); writeFileSync(join(local, 'SKILL.md'), 'local');
    skills = [];
    await assert.rejects(syncSkills({ ...options, restart: () => { throw new Error('restart failure'); } }), /restart failure/);
    assert.equal(existsSync(join(options.hermesHome, 'skills/registry/fixture')), false);
    assert.ok(existsSync(join(local, 'SKILL.md')));
    await syncSkills(options); assert.equal(restarts, 2);
    skills = [{ ...entry, archiveUrl: 'https://registry.test.evil.invalid/v1/skills/fixture/releases/1.0.0/archive' }];
    await assert.rejects(syncSkills(options), /origin/);
    await assert.rejects(syncSkills({ ...options, registry: 'https://other-install.test' }), /different registry/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const boundary of ['prepared', 'backed-up', 'activated', 'published']) test(`recovers activation interrupted at ${boundary}`, async () => {
  const f = fixture();
  try {
    let bytes = f.pack();
    const entry = () => ({ slug: 'fixture', version: '1.0.0', sha256: createHash('sha256').update(bytes).digest('hex'), archiveUrl: 'https://registry.test/v1/skills/fixture/releases/1.0.0/archive' });
    const options = { registry: 'https://registry.test', hermesHome: join(f.root, 'hermes'), hermesVersion: '2.4.0', fetchImpl: async (url) => new URL(url).pathname.endsWith('/manifest') ? Response.json({ schemaVersion: 1, skills: [entry()] }) : new Response(bytes), restart: () => {} };
    await syncSkills(options);
    writeFileSync(join(f.source, 'SKILL.md'), '# Updated fixture'); bytes = f.pack();
    await assert.rejects(syncSkills({ ...options, checkpoint: (step) => { if (step === boundary) throw new Error('interrupted'); } }), /interrupted/);
    await syncSkills(options);
    assert.equal(readFileSync(join(options.hermesHome, 'skills/registry/fixture/SKILL.md'), 'utf8'), '# Updated fixture');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('canary manifests download from the channel-scoped archive URL', async () => {
  const f = fixture();
  try {
    const bytes = f.pack();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const base = 'https://registry.test/v1/skills/fixture/releases/1.1.0/archive';
    const fetched = [];
    let archiveUrl = base + '?channel=canary';
    const fetchImpl = async (url) => {
      if (new URL(url).pathname.endsWith('/manifest')) {
        return Response.json({ schemaVersion: 1, channel: 'canary', skills: [{ slug: 'fixture', version: '1.1.0', sha256, archiveUrl }] });
      }
      if (new URL(url).pathname.startsWith('/v1/agent/receipts/')) return Response.json({ ok: true });
      fetched.push(String(url));
      return new Response(bytes);
    };
    const options = { registry: 'https://registry.test', hermesHome: join(f.root, 'hermes'), hermesVersion: '2.4.0', fetchImpl, target: 'agent-1', token: 'tok', restart: () => {} };
    await syncSkills(options);
    assert.deepEqual(fetched, [base + '?channel=canary']);
    archiveUrl = base;
    await assert.rejects(syncSkills({ ...options, hermesHome: join(f.root, 'other') }), /Unexpected archive origin or path/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('managed synchronization consumes the exact frozen publication instead of a changed live manifest', async () => {
 const f=fixture();try{
  const bytes=f.pack(),entry={slug:'fixture',version:'1.0.0',sha256:createHash('sha256').update(bytes).digest('hex'),archiveUrl:'https://registry.test/v1/skills/fixture/releases/1.0.0/archive'};
  let calls=0;
  await syncSkills({registry:'https://registry.test',hermesHome:join(f.root,'hermes'),hermesVersion:'2.4.0',frozenManifest:{schemaVersion:1,channel:'stable',skills:[entry]},restart:()=>{},fetchImpl:async url=>{calls++;assert.ok(!new URL(url).pathname.endsWith('/manifest'));return new Response(bytes)}});
  assert.equal(calls,1);assert.equal(readFileSync(join(f.root,'hermes/skills/registry/fixture/SKILL.md'),'utf8'),'# Fixture\n');
 }finally{rmSync(f.root,{recursive:true,force:true})}
});

test('frozen publications preserve current native target revocation and exact assignment checks before profile writes', async()=>{
 const f=fixture();try{
  const frozenManifest={schemaVersion:1,channel:'stable',skills:[]};let calls=0;
  const options={registry:'https://registry.test',hermesHome:join(f.root,'hermes'),target:'fixture-target',token:'obviously-fake-target-token',hermesVersion:'2.4.0',frozenManifest,restart:()=>{}};
  await assert.rejects(syncSkills({...options,fetchImpl:async()=>{calls++;return new Response('',{status:401})}}));assert.equal(calls,1);assert.ok(!existsSync(options.hermesHome));
  await assert.rejects(syncSkills({...options,fetchImpl:async()=>Response.json({...frozenManifest,skills:[{slug:'changed'}]})}),/current authorized target assignment/);assert.ok(!existsSync(options.hermesHome));
  await syncSkills({...options,fetchImpl:async()=>Response.json({...frozenManifest,generatedAt:'ignored-publication-timestamp'})});assert.ok(existsSync(options.hermesHome));
 }finally{rmSync(f.root,{recursive:true,force:true})}
});

test('pinned publisher keys refuse an unsigned or foreign release before anything is activated', async () => {
  const f = fixture();
  try {
    const bytes = f.pack();
    const key = join(f.root, 'publisher.pem'), foreignKey = join(f.root, 'foreign.pem');
    const publisherKeys = parsePublisherKeys(JSON.stringify([keygen({ out: key, keyId: 'example' })]));
    keygen({ out: foreignKey, keyId: 'example' });
    const entry = { slug: 'fixture', version: '1.0.0', sha256: createHash('sha256').update(bytes).digest('hex'), archiveUrl: 'https://registry.test/v1/skills/fixture/releases/1.0.0/archive' };
    let signature = null; const requests = [];
    const fetchImpl = async (url, init) => {
      const path = new URL(url).pathname; requests.push(path);
      if (path.endsWith('/manifest')) return Response.json({ schemaVersion: 1, skills: [entry] });
      if (path === '/v1/skills/fixture/releases/1.0.0') { assert.equal(init.headers.authorization, 'Bearer target-token'); return Response.json({ slug: 'fixture', version: '1.0.0', sha256: entry.sha256, signature }); }
      if (path.endsWith('/receipts/agent-1')) return Response.json({ ok: true });
      return new Response(bytes);
    };
    const options = { registry: 'https://registry.test', hermesHome: join(f.root, 'hermes'), hermesVersion: '2.4.0', fetchImpl, target: 'agent-1', token: 'target-token', publisherKeys, restart: () => {} };
    await assert.rejects(syncSkills(options), /no valid signature/);
    signature = { keyId: 'example', value: signRelease({ key: foreignKey, keyId: 'example', slug: 'fixture', version: '1.0.0', sha256: entry.sha256 }).signature };
    await assert.rejects(syncSkills(options), /no valid signature/);
    assert.equal(requests.some((path) => path.endsWith('/archive')), false, 'no archive was downloaded');
    assert.equal(existsSync(join(options.hermesHome, 'skills/registry/fixture')), false);
    await assert.rejects(syncSkills({ ...options, target: undefined, token: undefined }), /enrolled target/);
    signature = { keyId: 'example', value: signRelease({ key, keyId: 'example', slug: 'fixture', version: '1.0.0', sha256: entry.sha256 }).signature };
    await syncSkills(options);
    assert.ok(existsSync(join(options.hermesHome, 'skills/registry/fixture/SKILL.md')));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a failed restart posts restart_failed naming only the skills installed since the last clean restart', async () => {
  const f = fixture();
  try {
    const bytes = f.pack();
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const entry = (slug) => ({ slug, version: '1.0.0', sha256, archiveUrl: `https://registry.test/v1/skills/${slug}/releases/1.0.0/archive` });
    let skills = [entry('steady')]; const receipts = [];
    const fetchImpl = async (url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/manifest')) return Response.json({ schemaVersion: 1, skills });
      if (path === '/v1/agent/receipts/agent-1') { receipts.push(JSON.parse(init.body)); return Response.json({ ok: true }); }
      return new Response(bytes);
    };
    let fail = false;
    const options = { registry: 'https://registry.test', hermesHome: join(f.root, 'hermes'), hermesVersion: '2.4.0', fetchImpl, target: 'agent-1', token: 'tok', restart: () => { if (fail) throw new Error('gateway down'); } };
    await syncSkills(options);
    assert.deepEqual(receipts.map((item) => [item.status, item.changed]), [['activated', ['steady']]]);
    // A later run installs one more skill and the restart fails: only that skill is blamed.
    skills = [entry('steady'), entry('incoming')]; fail = true;
    await assert.rejects(syncSkills(options), /gateway down/);
    assert.deepEqual([receipts.at(-1).status, receipts.at(-1).changed, Object.keys(receipts.at(-1).skills).sort()], ['restart_failed', ['incoming'], ['incoming', 'steady']]);
    const local = JSON.parse(readFileSync(join(options.hermesHome, '.hive-skills-sync/receipt.json'), 'utf8'));
    assert.deepEqual([local.status, local.changed], ['restart_failed', ['incoming']]);
    // The next run has nothing new to install but still owes the restart, and still names the skill.
    await assert.rejects(syncSkills(options), /gateway down/);
    assert.deepEqual([receipts.at(-1).status, receipts.at(-1).changed], ['restart_failed', ['incoming']]);
    fail = false;
    await syncSkills(options);
    assert.deepEqual([receipts.at(-1).status, receipts.at(-1).changed], ['activated', ['incoming']]);
    await syncSkills(options);
    assert.deepEqual([receipts.at(-1).status, receipts.at(-1).changed], ['activated', []]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('a restart_failed receipt that cannot be uploaded does not hide the restart error', async () => {
  const f = fixture();
  try {
    const bytes = f.pack();
    const entry = { slug: 'fixture', version: '1.0.0', sha256: createHash('sha256').update(bytes).digest('hex'), archiveUrl: 'https://registry.test/v1/skills/fixture/releases/1.0.0/archive' };
    const fetchImpl = async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/manifest')) return Response.json({ schemaVersion: 1, skills: [entry] });
      if (path.startsWith('/v1/agent/receipts/')) return new Response('unavailable', { status: 503 });
      return new Response(bytes);
    };
    const quiet = console.error; console.error = () => {};
    try {
      await assert.rejects(syncSkills({ registry: 'https://registry.test', hermesHome: join(f.root, 'hermes'), hermesVersion: '2.4.0', fetchImpl, target: 'agent-1', token: 'tok', restart: () => { throw new Error('gateway down'); } }), /gateway down/);
    } finally { console.error = quiet; }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('the gateway restart checks a running gateway stays up', async () => {
  const fake = (states) => {
    const calls = []; let restarts = 0; let active = states.shift();
    const run = (command, args) => {
      assert.equal(command, '/usr/bin/systemctl');
      const verb = args[1]; calls.push(verb);
      if (verb === 'is-active') return { status: active ? 0 : 3 };
      if (verb === 'try-restart') { active = states.shift() ?? active; return { status: 0 }; }
      if (verb === 'show') return { status: 0, stdout: `${restarts}\n` };
      throw new Error(`unexpected ${verb}`);
    };
    return { calls, run, crash: () => { restarts++; }, setActive: (value) => { active = value; } };
  };
  const slept = [];
  // Running before and after: healthy.
  let systemd = fake([true, true]);
  await restartGateway({ run: systemd.run, sleep: async (ms) => { slept.push(ms); }, settleMs: 5 });
  assert.deepEqual(systemd.calls, ['is-active', 'try-restart', 'show', 'is-active', 'show']);
  assert.deepEqual(slept, [5]);
  // Running before, down after the settle delay.
  systemd = fake([true, true]);
  await assert.rejects(restartGateway({ run: systemd.run, sleep: async () => { systemd.setActive(false); }, settleMs: 0 }), /not running after the restart/);
  // Up again, but systemd had to restart it meanwhile (a crash loop).
  systemd = fake([true, true]);
  await assert.rejects(restartGateway({ run: systemd.run, sleep: async () => { systemd.crash(); }, settleMs: 0 }), /restarted again/);
  // Not running before: try-restart leaves it stopped and that is not a failure.
  systemd = fake([false, false]);
  await restartGateway({ run: systemd.run, sleep: async () => { throw new Error('no settle wait'); } });
  assert.deepEqual(systemd.calls, ['is-active', 'try-restart']);
  // try-restart itself failing.
  await assert.rejects(restartGateway({ run: (command, args) => ({ status: args[1] === 'try-restart' ? 1 : 0 }) }), /restart failed/);
});
test('skills installed before publisher keys were pinned are checked, reported or quarantined', async () => {
  const f = fixture();
  try {
    const bytes = f.pack();
    const key = join(f.root, 'publisher.pem');
    const publisherKeys = parsePublisherKeys(JSON.stringify([keygen({ out: key, keyId: 'example' })]));
    const entry = (slug) => ({ slug, version: '1.0.0', sha256: createHash('sha256').update(bytes).digest('hex'), archiveUrl: `https://registry.test/v1/skills/${slug}/releases/1.0.0/archive` });
    const signatures = { signed: { keyId: 'example', value: signRelease({ key, keyId: 'example', slug: 'signed', version: '1.0.0', sha256: entry('signed').sha256 }).signature }, legacy: null };
    const metadataReads = [];
    const fetchImpl = async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/manifest')) return Response.json({ schemaVersion: 1, skills: [entry('signed'), entry('legacy')] });
      const metadata = /^\/v1\/skills\/([a-z-]+)\/releases\/1\.0\.0$/.exec(path);
      if (metadata) { metadataReads.push(metadata[1]); return Response.json({ slug: metadata[1], version: '1.0.0', sha256: entry(metadata[1]).sha256, signature: signatures[metadata[1]] }); }
      if (path.startsWith('/v1/agent/receipts/')) return Response.json({ ok: true });
      return new Response(bytes);
    };
    let restarts = 0;
    const options = { registry: 'https://registry.test', hermesHome: join(f.root, 'hermes'), hermesVersion: '2.4.0', fetchImpl, target: 'agent-1', token: 'tok', restart: () => { restarts++; } };
    // Both installed while no key was pinned.
    await syncSkills(options);
    assert.equal(restarts, 1);
    // Keys pinned, default: the unsigned installed skill is reported and stays active.
    const warnings = []; const warn = console.warn; console.warn = (message) => warnings.push(message);
    try { await syncSkills({ ...options, publisherKeys }); } finally { console.warn = warn; }
    assert.match(warnings.join('\n'), /legacy 1\.0\.0/);
    assert.doesNotMatch(warnings.join('\n'), /signed 1\.0\.0/);
    assert.ok(existsSync(join(options.hermesHome, 'skills/registry/legacy/SKILL.md')));
    // A verified signature is remembered: the next run reads only the unverified skill's metadata.
    metadataReads.length = 0;
    console.warn = () => {};
    try { await syncSkills({ ...options, publisherKeys }); } finally { console.warn = warn; }
    assert.deepEqual(metadataReads, ['legacy']);
    // Quarantine: the unsigned skill leaves the gateway's directory, the gateway restarts and the sync fails.
    await assert.rejects(syncSkills({ ...options, publisherKeys, unsignedInstalled: 'quarantine' }), /Quarantined installed skills .*legacy 1\.0\.0/);
    assert.equal(existsSync(join(options.hermesHome, 'skills/registry/legacy')), false);
    assert.ok(existsSync(join(options.hermesHome, '.hive-skills-sync/legacy.quarantined/SKILL.md')));
    assert.ok(existsSync(join(options.hermesHome, 'skills/registry/signed/SKILL.md')));
    assert.equal(restarts, 2);
    // From then on it is treated like any unsigned release: the sync is refused until it is signed.
    await assert.rejects(syncSkills({ ...options, publisherKeys }), /legacy 1\.0\.0 has no valid signature/);
    signatures.legacy = { keyId: 'example', value: signRelease({ key, keyId: 'example', slug: 'legacy', version: '1.0.0', sha256: entry('legacy').sha256 }).signature };
    await syncSkills({ ...options, publisherKeys });
    assert.ok(existsSync(join(options.hermesHome, 'skills/registry/legacy/SKILL.md')));
    await assert.rejects(syncSkills({ ...options, unsignedInstalled: 'delete' }), /report or quarantine/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

// Signed revocation lists ------------------------------------------------------------------------
import { signRevocations } from './sign-release.mjs';

function revocationFixture() {
  const f = fixture();
  // Each content label packs its own archive, so different skills have different digests.
  const archives = new Map();
  const pack = (content) => {
    if (!archives.has(content)) { writeFileSync(join(f.source, 'SKILL.md'), `# ${content}\n`); archives.set(content, f.pack()); }
    return archives.get(content);
  };
  const shaOf = (content) => createHash('sha256').update(pack(content)).digest('hex');
  const sha256 = shaOf('fixture');
  const served = new Map();
  const publisherKey = join(f.root, 'publisher.pem'), newPublisherKey = join(f.root, 'publisher-new.pem'), authorityKey = join(f.root, 'authority.pem'), otherAuthorityKey = join(f.root, 'other-authority.pem');
  const publisher = keygen({ out: publisherKey, keyId: 'publisher-2026' });
  const newPublisher = keygen({ out: newPublisherKey, keyId: 'publisher-2027' });
  const authority = keygen({ out: authorityKey, keyId: 'revocations-2026' });
  keygen({ out: otherAuthorityKey, keyId: 'revocations-2026' });
  const entry = (slug, version = '1.0.0', content = slug) => { served.set(`${slug}@${version}`, content); return { slug, version, sha256: shaOf(content), archiveUrl: `https://registry.test/v1/skills/${slug}/releases/${version}/archive` }; };
  const contentOf = (slug, version) => served.get(`${slug}@${version}`) ?? slug;
  const sign = (signer, slug, version = '1.0.0') => ({ keyId: signer.keyId, value: signRelease({ key: signer.file, keyId: signer.keyId, slug, version, sha256: shaOf(contentOf(slug, version)) }).signature });
  const signers = { current: { file: publisherKey, keyId: publisher.keyId }, next: { file: newPublisherKey, keyId: newPublisher.keyId } };
  const list = (sequence, { keys = [], releases = [], expiresAt = null, issuedAt, key = authorityKey } = {}) => signRevocations({ key, keyId: 'revocations-2026', list: { sequence, expiresAt, keys, releases, ...(issuedAt ? { issuedAt } : {}) } });
  const state = { manifest: [], signatures: {}, revocations: list(1), receipts: [], requests: [] };
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname; state.requests.push(path);
    if (path.endsWith('/manifest')) return Response.json({ schemaVersion: 1, skills: state.manifest });
    if (path === '/v1/revocations') { assert.equal(init.headers.authorization, 'Bearer tok'); return state.revocations ? Response.json({ sequence: 0, ...state.revocations }) : Response.json({ error: { code: 'revocations_unpublished' } }, { status: 404 }); }
    const metadata = /^\/v1\/skills\/([a-z-]+)\/releases\/([0-9.]+)$/.exec(path);
    if (metadata) return Response.json({ slug: metadata[1], version: metadata[2], sha256: shaOf(contentOf(metadata[1], metadata[2])), signature: state.signatures[metadata[1]] ?? null });
    if (path.startsWith('/v1/agent/receipts/')) { state.receipts.push(JSON.parse(init.body)); return Response.json({ ok: true }); }
    const archive = /^\/v1\/skills\/([a-z-]+)\/releases\/([^/]+)\/archive$/.exec(path);
    return new Response(pack(contentOf(archive[1], archive[2])));
  };
  let restarts = 0;
  const options = { registry: 'https://registry.test', hermesHome: join(f.root, 'hermes'), hermesVersion: '2.4.0', fetchImpl, target: 'agent-1', token: 'tok', restart: () => { restarts++; }, revocationKeys: parsePublisherKeys(JSON.stringify([authority])) };
  return { f, sha256, shaOf, contentOf, publisher, newPublisher, signers, otherAuthorityKey, entry, sign, list, state, options, restarts: () => restarts, publisherKeys: parsePublisherKeys(JSON.stringify([publisher, newPublisher])) };
}

test('pinned revocation keys fail closed on a missing, foreign, altered or expired list before anything is activated', async () => {
  const r = revocationFixture();
  try {
    r.state.manifest = [r.entry('fixture')];
    r.state.revocations = null;
    await assert.rejects(syncSkills(r.options), /serves no revocation list/);
    r.state.revocations = r.list(1, { key: r.otherAuthorityKey });
    await assert.rejects(syncSkills(r.options), /signature does not verify/);
    r.state.revocations = { ...r.list(1), payload: r.list(1).payload.replace('"sequence":1', '"sequence":9') };
    await assert.rejects(syncSkills(r.options), /signature does not verify/);
    r.state.revocations = { ...r.list(1), signature: { keyId: 'unknown', value: r.list(1).signature.value } };
    await assert.rejects(syncSkills(r.options), /not a pinned revocation key/);
    r.state.revocations = r.list(1, { issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z' });
    await assert.rejects(syncSkills({ ...r.options, now: () => Date.parse('2026-01-03T00:00:00Z') }), /expired at 2026-01-02/);
    assert.equal(r.state.requests.some((path) => path.endsWith('/archive')), false, 'no archive was downloaded');
    assert.equal(existsSync(join(r.options.hermesHome, 'skills/registry/fixture')), false);
    await assert.rejects(syncSkills({ ...r.options, target: undefined, token: undefined }), /enrolled target/);
    await assert.rejects(syncSkills({ ...r.options, revokedInstalled: 'delete' }), /quarantine or report/);
    // A valid, unexpired list lets the sync proceed.
    await syncSkills({ ...r.options, now: () => Date.parse('2026-01-01T12:00:00Z') });
    assert.ok(existsSync(join(r.options.hermesHome, 'skills/registry/fixture/SKILL.md')));
  } finally { rmSync(r.f.root, { recursive: true, force: true }); }
});

test('the bridge keeps the highest revocation sequence and refuses a rolled-back or swapped list', async () => {
  const r = revocationFixture();
  try {
    r.state.manifest = [r.entry('fixture')];
    r.state.revocations = r.list(2);
    await syncSkills(r.options);
    const saved = JSON.parse(readFileSync(join(r.options.hermesHome, 'skills/registry/.hive-skills-state.json'), 'utf8'));
    assert.equal(saved.revocations.sequence, 2);
    r.state.revocations = r.list(1);
    await assert.rejects(syncSkills(r.options), /older than list 2/);
    r.state.revocations = r.list(2, { releases: [{ slug: 'other', version: '1.0.0', sha256: r.shaOf('other'), reason: 'Synthetic swap' }] });
    await assert.rejects(syncSkills(r.options), /different revocation list 2/);
    r.state.revocations = r.list(3);
    await syncSkills(r.options);
    // A list seen once is remembered even when the sync then fails.
    r.state.manifest = [r.entry('fixture'), r.entry('incoming')];
    r.state.revocations = r.list(4, { releases: [{ slug: 'incoming', version: '1.0.0', sha256: r.shaOf('incoming'), reason: 'Synthetic incident' }] });
    await assert.rejects(syncSkills(r.options), /Refused revoked releases: incoming/);
    r.state.revocations = r.list(3);
    await assert.rejects(syncSkills(r.options), /older than list 4/);
  } finally { rmSync(r.f.root, { recursive: true, force: true }); }
});

test('a revoked release is refused before download and reported to the registry', async () => {
  const r = revocationFixture();
  try {
    r.state.manifest = [r.entry('fixture'), r.entry('steady')];
    r.state.revocations = r.list(1, { releases: [{ slug: 'fixture', version: '1.0.0', sha256: r.sha256, reason: 'Synthetic incident' }] });
    await assert.rejects(syncSkills(r.options), /Refused revoked releases: fixture 1\.0\.0 \(release revoked: Synthetic incident\)/);
    assert.equal(r.state.requests.some((path) => path.endsWith('/archive')), false);
    assert.equal(existsSync(join(r.options.hermesHome, 'skills/registry/steady')), false, 'nothing else was activated');
    assert.deepEqual([r.state.receipts.at(-1).status, r.state.receipts.at(-1).revocations], ['revoked', [{ slug: 'fixture', version: '1.0.0', reason: 'release', action: 'refused' }]]);
    // The registry withdraws it; the rest syncs.
    r.state.manifest = [r.entry('steady')];
    await syncSkills(r.options);
    assert.ok(existsSync(join(r.options.hermesHome, 'skills/registry/steady/SKILL.md')));
  } finally { rmSync(r.f.root, { recursive: true, force: true }); }
});

test('an installed release that is revoked later is quarantined by default, or only reported', async () => {
  const r = revocationFixture();
  try {
    r.state.manifest = [r.entry('fixture'), r.entry('steady')];
    await syncSkills(r.options);
    assert.equal(r.restarts(), 1);
    r.state.revocations = r.list(2, { releases: [{ slug: 'fixture', version: '1.0.0', sha256: r.sha256, reason: 'Synthetic incident' }] });
    // report: it stays active, a warning names it and the activated receipt carries it.
    const warnings = []; const warn = console.warn; console.warn = (message) => warnings.push(message);
    try { await syncSkills({ ...r.options, revokedInstalled: 'report' }); } finally { console.warn = warn; }
    assert.match(warnings.join('\n'), /revoked stay active .*fixture 1\.0\.0/);
    assert.ok(existsSync(join(r.options.hermesHome, 'skills/registry/fixture/SKILL.md')));
    assert.deepEqual([r.state.receipts.at(-1).status, r.state.receipts.at(-1).revocations], ['activated', [{ slug: 'fixture', version: '1.0.0', reason: 'release', action: 'reported' }]]);
    // Default: quarantined, gateway restarted, registry told, sync fails.
    await assert.rejects(syncSkills(r.options), /Quarantined installed skills whose release or signing key is revoked: fixture 1\.0\.0/);
    assert.equal(existsSync(join(r.options.hermesHome, 'skills/registry/fixture')), false);
    assert.ok(existsSync(join(r.options.hermesHome, '.hive-skills-sync/fixture.quarantined/SKILL.md')));
    assert.ok(existsSync(join(r.options.hermesHome, 'skills/registry/steady/SKILL.md')));
    assert.equal(r.restarts(), 2);
    assert.deepEqual([r.state.receipts.at(-1).status, r.state.receipts.at(-1).revocations, Object.keys(r.state.receipts.at(-1).skills)], ['revoked', [{ slug: 'fixture', version: '1.0.0', reason: 'release', action: 'quarantined' }], ['steady']]);
    // While the registry still offers it, it is refused like any revoked release.
    await assert.rejects(syncSkills(r.options), /Refused revoked releases: fixture/);
  } finally { rmSync(r.f.root, { recursive: true, force: true }); }
});

test('a revoked publisher key no longer vouches for releases, even ones verified and remembered before', async () => {
  const r = revocationFixture();
  try {
    const options = { ...r.options, publisherKeys: r.publisherKeys };
    r.state.manifest = [r.entry('fixture')];
    r.state.signatures.fixture = r.sign(r.signers.current, 'fixture');
    await syncSkills(options);
    assert.ok(existsSync(join(r.options.hermesHome, 'skills/registry/fixture/SKILL.md')));
    const revokeKey = { keys: [{ keyId: 'publisher-2026', publicKey: r.publisher.publicKey, reason: 'Synthetic key compromise' }] };
    r.state.revocations = r.list(2, revokeKey);
    await assert.rejects(syncSkills(options), /Quarantined installed skills whose release or signing key is revoked: fixture 1\.0\.0 \(signing key publisher-2026 revoked: Synthetic key compromise\)/);
    assert.deepEqual(r.state.receipts.at(-1).revocations, [{ slug: 'fixture', version: '1.0.0', reason: 'key', keyId: 'publisher-2026', action: 'quarantined' }]);
    // A new release signed by the revoked key is refused; re-signed with the new key it installs.
    r.state.manifest = [r.entry('fixture', '1.1.0')];
    r.state.signatures.fixture = r.sign(r.signers.current, 'fixture', '1.1.0');
    await assert.rejects(syncSkills(options), /Refused revoked releases: fixture 1\.1\.0 \(signing key publisher-2026 revoked/);
    r.state.signatures.fixture = r.sign(r.signers.next, 'fixture', '1.1.0');
    await syncSkills(options);
    assert.ok(existsSync(join(r.options.hermesHome, 'skills/registry/fixture/SKILL.md')));
    // A revocation of the same key id with a different public key does not apply.
    r.state.revocations = r.list(3, { keys: [{ keyId: 'publisher-2027', publicKey: r.publisher.publicKey, reason: 'Different key' }] });
    await syncSkills(options);
  } finally { rmSync(r.f.root, { recursive: true, force: true }); }
});

test('signed revocation lists are validated exactly', () => {
  const r = revocationFixture();
  try {
    const signed = r.list(1, { keys: [{ keyId: 'publisher-2026', publicKey: r.publisher.publicKey, reason: 'Synthetic' }] });
    const parsed = JSON.parse(signed.payload);
    assert.equal(parsed.schema, 'hiveskills-revocations-v1');
    assert.equal(parsed.keys[0].revokedAt, parsed.issuedAt, 'revokedAt defaults to issuedAt');
    const bad = [
      { sequence: 0, keys: [], releases: [] },
      { sequence: 1, keys: [], releases: [], extra: true },
      { sequence: 1, keys: [{ keyId: 'x', publicKey: 'AAAA', reason: 'r' }], releases: [] },
      { sequence: 1, keys: [], releases: [{ slug: 'Bad Slug', version: '1.0.0', sha256: r.sha256, reason: 'r' }] },
      { sequence: 1, keys: [], releases: [{ slug: 'fixture', version: '1.0.0', sha256: r.sha256, reason: '' }] },
      { sequence: 1, keys: [], releases: [{ slug: 'fixture', version: '1.0.0', sha256: r.sha256, reason: 'r' }, { slug: 'fixture', version: '1.0.0', sha256: r.sha256, reason: 'r' }] },
      { sequence: 1, keys: [], releases: [], expiresAt: '2000-01-01T00:00:00Z' },
    ];
    for (const list of bad) assert.throws(() => signRevocations({ key: join(r.f.root, 'authority.pem'), keyId: 'revocations-2026', list }), Error, JSON.stringify(list));
  } finally { rmSync(r.f.root, { recursive: true, force: true }); }
});

// Regression: revoked code must not survive under another label or behind a withheld signature.
function relabelFixture() {
  const r = revocationFixture();
  const signatures = {};
  const base = r.options.fetchImpl;
  r.options.fetchImpl = async (url, init) => {
    const metadata = /^\/v1\/skills\/([a-z-]+)\/releases\/([^/]+)$/.exec(new URL(url).pathname);
    if (metadata && !metadata[2].endsWith('/archive')) return Response.json({ slug: metadata[1], version: metadata[2], sha256: r.entry(metadata[1], metadata[2], r.contentOf(metadata[1], metadata[2])).sha256, signature: signatures[`${metadata[1]}@${metadata[2]}`] ?? null });
    return base(url, init);
  };
  return { ...r, signatures, options: { ...r.options, publisherKeys: r.publisherKeys } };
}

test('a revoked release relabelled as another version with the same bytes stays revoked', async () => {
  const r = relabelFixture();
  try {
    r.state.manifest = [r.entry('evil', '1.0.0')];
    r.signatures['evil@1.0.0'] = r.sign(r.signers.current, 'evil');
    await syncSkills(r.options);
    r.state.revocations = r.list(2, { releases: [{ slug: 'evil', version: '1.0.0', sha256: r.shaOf('evil'), reason: 'Synthetic malware' }] });
    r.state.manifest = [r.entry('evil', '1.0.0-x', 'evil')];
    await assert.rejects(syncSkills(r.options), /Quarantined installed skills whose release or signing key is revoked: evil/);
    assert.equal(existsSync(join(r.options.hermesHome, 'skills/registry/evil')), false, 'revoked code no longer active');
    // Offered again under yet another name, the digest still matches and it is refused before download.
    r.state.manifest = [r.entry('renamed', '9.9.9', 'evil')];
    r.state.requests.length = 0;
    await assert.rejects(syncSkills(r.options), /Refused revoked releases: renamed 9\.9\.9/);
    assert.equal(r.state.requests.some((path) => path.endsWith('/archive')), false);
  } finally { rmSync(r.f.root, { recursive: true, force: true }); }
});

test('an installed release relabelled without revocation keys pinned for publishers is still checked against the installed record', async () => {
  const r = revocationFixture();
  try {
    r.state.manifest = [r.entry('evil', '1.0.0')];
    await syncSkills(r.options);
    r.state.revocations = r.list(2, { releases: [{ slug: 'evil', version: '1.0.0', sha256: 'f'.repeat(64), reason: 'Synthetic incident' }] });
    r.state.manifest = [r.entry('evil', '1.0.0-x')];
    await assert.rejects(syncSkills(r.options), /Quarantined installed skills .*evil 1\.0\.0 \(release revoked/);
  } finally { rmSync(r.f.root, { recursive: true, force: true }); }
});

test('withholding the signature of an installed release whose key was revoked does not downgrade it to unsigned', async () => {
  const r = relabelFixture();
  try {
    r.state.manifest = [r.entry('evil', '1.0.0')];
    r.signatures['evil@1.0.0'] = r.sign(r.signers.current, 'evil');
    await syncSkills(r.options);
    r.state.revocations = r.list(2, { keys: [{ keyId: 'publisher-2026', publicKey: r.publisher.publicKey, reason: 'Synthetic key theft' }] });
    delete r.signatures['evil@1.0.0'];
    await assert.rejects(syncSkills(r.options), /Quarantined installed skills whose release or signing key is revoked: evil 1\.0\.0 \(signing key publisher-2026 revoked/);
    assert.equal(existsSync(join(r.options.hermesHome, 'skills/registry/evil')), false);
  } finally { rmSync(r.f.root, { recursive: true, force: true }); }
});

test('a key is revoked by its public key, under any key id', async () => {
  const r = relabelFixture();
  try {
    r.state.manifest = [r.entry('evil', '1.0.0')];
    r.signatures['evil@1.0.0'] = r.sign(r.signers.current, 'evil');
    await syncSkills(r.options);
    r.state.revocations = r.list(2, { keys: [{ keyId: 'some-other-id', publicKey: r.publisher.publicKey, reason: 'Synthetic key theft' }] });
    await assert.rejects(syncSkills(r.options), /Quarantined installed skills .*signing key publisher-2026 revoked/);
  } finally { rmSync(r.f.root, { recursive: true, force: true }); }
});

test('a pinned minimum revocation sequence survives a lost state file', async () => {
  const r = revocationFixture();
  try {
    r.state.manifest = [r.entry('fixture')];
    r.state.revocations = r.list(1);
    await assert.rejects(syncSkills({ ...r.options, minRevocationSequence: 2 }), /older than the pinned minimum 2/);
    r.state.revocations = r.list(2);
    await syncSkills({ ...r.options, minRevocationSequence: 2 });
    await assert.rejects(syncSkills({ ...r.options, minRevocationSequence: -1 }), /non-negative integer/);
    await assert.rejects(syncSkills({ ...r.options, revocationKeys: new Map(), minRevocationSequence: 2 }), /needs HIVE_SKILLS_REVOCATION_KEYS/);
  } finally { rmSync(r.f.root, { recursive: true, force: true }); }
});

// Regression: an installed revoked skill is dealt with whatever the manifest offers for it now.
test('a key-revoked installed skill is quarantined even when the manifest moves it to a new, unsigned version', async () => {
  const r = relabelFixture();
  try {
    r.state.manifest = [r.entry('evil', '1.0.0')];
    r.signatures['evil@1.0.0'] = r.sign(r.signers.current, 'evil');
    await syncSkills(r.options);
    r.state.revocations = r.list(2, { keys: [{ keyId: 'publisher-2026', publicKey: r.publisher.publicKey, reason: 'Synthetic key theft' }] });
    r.state.manifest = [r.entry('evil', '1.0.1', 'evil-two')];
    await assert.rejects(syncSkills(r.options), /Quarantined installed skills whose release or signing key is revoked: evil 1\.0\.0 \(signing key publisher-2026 revoked/);
    assert.equal(existsSync(join(r.options.hermesHome, 'skills/registry/evil')), false);
    assert.deepEqual(r.state.receipts.at(-1).revocations, [{ slug: 'evil', version: '1.0.0', reason: 'key', keyId: 'publisher-2026', action: 'quarantined' }]);
    // The new version still needs a valid signature of its own.
    await assert.rejects(syncSkills(r.options), /evil 1\.0\.1 has no valid signature/);
    r.signatures['evil@1.0.1'] = r.sign(r.signers.next, 'evil', '1.0.1');
    await syncSkills(r.options);
    assert.equal(readFileSync(join(r.options.hermesHome, 'skills/registry/evil/SKILL.md'), 'utf8'), '# evil-two\n');
  } finally { rmSync(r.f.root, { recursive: true, force: true }); }
});

test('in report mode a revoked installed skill does not let a new unsigned version through', async () => {
  const r = relabelFixture();
  try {
    const options = { ...r.options, revokedInstalled: 'report' };
    r.state.manifest = [r.entry('evil', '1.0.0')];
    r.signatures['evil@1.0.0'] = r.sign(r.signers.current, 'evil');
    await syncSkills(options);
    r.state.revocations = r.list(2, { releases: [{ slug: 'evil', version: '1.0.0', sha256: r.shaOf('evil'), reason: 'Synthetic malware' }] });
    r.state.manifest = [r.entry('evil', '2.0.0', 'unsigned-payload')];
    const warn = console.warn; console.warn = () => {};
    try { await assert.rejects(syncSkills(options), /evil 2\.0\.0 has no valid signature/); } finally { console.warn = warn; }
    assert.equal(readFileSync(join(r.options.hermesHome, 'skills/registry/evil/SKILL.md'), 'utf8'), '# evil\n', 'the unsigned version was not installed');
  } finally { rmSync(r.f.root, { recursive: true, force: true }); }
});

test('an unusable manifest or unreadable metadata does not keep a revoked installed skill running', async () => {
  const r = relabelFixture();
  try {
    r.state.manifest = [r.entry('evil', '1.0.0')];
    r.signatures['evil@1.0.0'] = r.sign(r.signers.current, 'evil');
    await syncSkills(r.options);
    r.state.revocations = r.list(2, { keys: [{ keyId: 'publisher-2026', publicKey: r.publisher.publicKey, reason: 'Synthetic key theft' }] });
    // A new version the bridge would refuse as incompatible.
    r.state.manifest = [{ ...r.entry('evil', '1.0.1', 'evil-two'), compatibility: { minHermesVersion: '9.0.0', maxHermesVersion: null } }];
    await assert.rejects(syncSkills(r.options), /Quarantined installed skills .*evil 1\.0\.0/);
    assert.equal(existsSync(join(r.options.hermesHome, 'skills/registry/evil')), false);
    // The manifest error itself is still reported afterwards.
    await assert.rejects(syncSkills(r.options), /incompatible/);
  } finally { rmSync(r.f.root, { recursive: true, force: true }); }
});
