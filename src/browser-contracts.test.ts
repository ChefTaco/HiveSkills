import assert from 'node:assert/strict';
import test from 'node:test';
import { CreateSkill, UpdateSkill, UploadRelease, UpdateTarget, PromoteRelease, EnrollTarget, Release, EnrollmentResponse } from './browser-contracts.js';
test('owned browser validators enforce text bounds, target identity and booleans',()=>{
 assert.equal(CreateSkill.parse({slug:'fixture',name:' Example ',description:'Description'}).name,'Example');
 for(const [schema,body] of [[UpdateSkill,{enabled:'true'}],[UpdateSkill,{name:' '.repeat(4)}],[UpdateTarget,{host:'host;command',username:'deploy'}],[UpdateTarget,{host:'agent.example.com',username:'deploy',enabled:'yes'}],[PromoteRelease,{version:'x'.repeat(65)}],[UploadRelease,{version:'1.0.0',archiveBase64:''}],[EnrollTarget,{channel:'stable',skills:['../escape']}]] as const)assert.equal(schema.safeParse(body).success,false);
});
test('browser exports strip archive paths while preserving exact one-time credentials',()=>{
 const release=Release.parse({skillSlug:'fixture',version:'1.0.0',sha256:'a'.repeat(64),notes:null,createdAt:'2026-01-01',archivePath:'/opt/skills/private.tgz'});
 assert.equal('archivePath' in release,false);
 assert.deepEqual(EnrollmentResponse.parse({target:'fixture',token:'obviously-fake-one-time-token',oneTime:true}),{target:'fixture',token:'obviously-fake-one-time-token',oneTime:true});
 assert.equal(EnrollmentResponse.safeParse({target:'fixture',token:'fake',oneTime:false}).success,false);
});
