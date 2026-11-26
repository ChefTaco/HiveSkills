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
