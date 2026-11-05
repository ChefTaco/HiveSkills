import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeSchema } from './schema.js';
import { DeploymentJournal, type Publication } from './deployment-journal.js';
const manifest:Publication={schemaVersion:1,channel:'stable',skills:[{slug:'fixture-skill',version:'1.0.0',sha256:'a'.repeat(64)}]};
function fixture(){const db=new DatabaseSync(':memory:');initializeSchema(db);let now=Date.now();return {db,journal:new DeploymentJournal(db,()=>now),advance:()=>{now+=300_001}}}
test('exact publication approval is owner-bound, one-use, expiring and durable before dispatch',()=>{const f=fixture();try{
 const first=f.journal.preview('fixture-target','admin',manifest);
 assert.equal(first.status,'awaiting_approval');assert.equal(f.journal.claim(),undefined);
 assert.throws(()=>f.journal.approve(String(first.id),'other',String(first.publication_sha256)),/owner/);
 assert.throws(()=>f.journal.approve(String(first.id),'admin','b'.repeat(64)),/differs/);
 f.journal.approve(String(first.id),'admin',String(first.publication_sha256));assert.throws(()=>f.journal.approve(String(first.id),'admin',String(first.publication_sha256)),/one-use/);
 assert.equal(f.journal.claim()?.id,first.id);assert.equal(f.journal.claim(),undefined);
 f.journal.recover();assert.equal(f.journal.get(String(first.id)).status,'unknown');assert.equal(f.journal.claim(),undefined);
 assert.throws(()=>f.journal.preview('fixture-target','admin',manifest),/unknown/);
 f.journal.outcome(String(first.id),'completed','signed completion','magnus-fixture');assert.equal(f.journal.get(String(first.id)).magnus_job_id,'magnus-fixture');
 const second=f.journal.preview('fixture-target','admin',manifest);f.advance();assert.throws(()=>f.journal.approve(String(second.id),'admin',String(second.publication_sha256)),/expired/);
}finally{f.db.close()}});
test('an approval expiring in the outbox cannot dispatch and legacy running state never replays',()=>{const f=fixture();try{
 const job=f.journal.preview('fixture-target','admin',manifest);f.journal.approve(String(job.id),'admin',String(job.publication_sha256));f.advance();assert.equal(f.journal.claim(),undefined);assert.equal(f.journal.get(String(job.id)).status,'failed');
 f.db.prepare("INSERT INTO deployment_jobs VALUES ('legacy','old-target','admin','running',NULL,'fixture','fixture')").run();f.journal.recover();assert.equal(f.db.prepare("SELECT status FROM deployment_jobs WHERE id='legacy'").get()?.status,'unknown');
}finally{f.db.close()}});
