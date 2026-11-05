import { readFileSync, lstatSync } from 'node:fs';
import { request } from 'node:https';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { maintenanceActive } from './release/runtime.js';
import { deploymentJournal } from './db.js';

export const executorConfiguration=z.object({url:z.url().refine(value=>{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash}),credentialFile:z.string().min(1),caFile:z.string().min(1).optional()}).strict();
export function magnusExecutorConfiguration(){
 if(!process.env.HIVE_SKILLS_MAGNUS_EXECUTOR_JSON)return null;
 return executorConfiguration.parse(JSON.parse(process.env.HIVE_SKILLS_MAGNUS_EXECUTOR_JSON));
}
export function requireMagnusExecutor(){if(!magnusExecutorConfiguration())throw new HTTPException(503,{message:'Skill execution requires an explicitly configured Magnus job adapter; native agents and credentials are provisioned through the host installer'})}
const result=z.object({jobId:z.string(),status:z.enum(['running','completed','failed','unknown','not_admitted']),result:z.string()}).strict();
export async function executeMagnusJob(id:string,reconcile=false){
 const config=magnusExecutorConfiguration();if(!config)throw new Error('Magnus executor is not configured');
 const row=deploymentJournal.get(id);
 const file=lstatSync(config.credentialFile);if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o077)!==0||file.uid!==process.getuid?.())throw new Error('Protected current-owner Magnus credential file required');
 const credential=readFileSync(config.credentialFile,'utf8').trim();if(credential.length<32||/[\r\n]/.test(credential))throw new Error('Invalid Magnus executor credential file');
 const url=new URL(config.url.replace(/\/$/,'')+'/api/v1/hiveskills/jobs/'+encodeURIComponent(id));
 if(reconcile)url.searchParams.set('target',String(row.target));
 const payload=reconcile?null:JSON.stringify({target:row.target,publicationSha256:row.publication_sha256,manifest:JSON.parse(String(row.manifest_json)),approvedBy:row.actor});
 return await new Promise<z.infer<typeof result>>((resolve,reject)=>{
  const req=request(url,{method:reconcile?'GET':'POST',...(config.caFile?{ca:readFileSync(config.caFile)}:{}),headers:{authorization:'Bearer '+credential,'content-type':'application/json','cache-control':'no-store'},timeout:125_000},res=>{
   const chunks:Buffer[]=[];let bytes=0;
   res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>64*1024){res.destroy();reject(new Error('Oversized Magnus job response'))}else chunks.push(chunk)});
   res.on('error',()=>reject(new Error('Magnus job response interrupted')));
   res.on('end',()=>{try{if(res.statusCode!==200)throw new Error('Magnus job rejected or unavailable');resolve(result.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))))}catch{reject(new Error('Magnus did not return a bounded job result'))}});
  });req.on('timeout',()=>req.destroy(new Error('Magnus job response deadline exceeded')));req.on('error',()=>reject(new Error('Magnus operation outcome requires reconciliation')));req.end(payload);
 });
}
export function startMagnusDeploymentWorker():()=>Promise<void>{
 if(process.env.HIVE_REHEARSAL==='true'||process.env.HIVE_SKILLS_DEPLOYMENT_WORKER_ENABLED==='false'||!magnusExecutorConfiguration())return async()=>{};
 let active:Promise<void>|null=null;deploymentJournal.recover();
 const timer=setInterval(()=>{if(active||maintenanceActive('/worker'))return;const job=deploymentJournal.claim();if(!job)return;const id=String(job.id);active=(async()=>{try{const reply=await executeMagnusJob(id);deploymentJournal.outcome(id,reply.status==='running'?'unknown':reply.status==='not_admitted'?'failed':reply.status,reply.result,reply.jobId)}catch{deploymentJournal.outcome(id,'unknown','Original dispatch may have started; reconcile its exact Magnus job without replay')}finally{active=null}})()},1000);timer.unref();
 return async()=>{clearInterval(timer);await active};
}
