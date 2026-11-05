#!/usr/bin/env node
// Export only reviewed public client files, never deployment state or a profile.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const root=resolve(import.meta.dirname,'..');
export const nativeClientFiles={'hermes-sync.mjs':'scripts/hermes-sync.mjs','archive-utils.mjs':'scripts/archive-utils.mjs',LICENSE:'LICENSE',NOTICE:'NOTICE'};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function buildNativeClient({output,url,nodeVersion=process.version,sourceRoot=root}){
 const selectedRoot=resolve(sourceRoot);
 const endpoint=new URL(url);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw Error('A public HTTPS artifact URL without credentials is required');
 if(!/^v(?:24\.22\.1|26\.13\.0)$/.test(nodeVersion))throw Error('Select an explicitly tested Node runtime version');
 const destination=resolve(output);if(existsSync(destination))throw Error('Select a new private artifact directory');
 execFileSync('git',['-C',selectedRoot,'diff','--quiet','HEAD','--',...Object.values(nativeClientFiles)],{stdio:'pipe'});
 for(const path of Object.values(nativeClientFiles)){if(!lstatSync(join(selectedRoot,path)).isFile())throw Error('Reviewed native client inputs must be regular files');execFileSync('git',['-C',selectedRoot,'ls-files','--error-unmatch',path],{stdio:'pipe'})}
 mkdirSync(destination,{recursive:true,mode:0o700});chmodSync(destination,0o700);
 const temporary=mkdtempSync(join(tmpdir(),'hiveskills-client-'));
 try{
  const files={};for(const [name,path]of Object.entries(nativeClientFiles)){const source=join(selectedRoot,path);copyFileSync(source,join(temporary,name));chmodSync(join(temporary,name),0o644);files[name]=sha(readFileSync(source))}
  const version=JSON.parse(readFileSync(join(selectedRoot,'package.json'),'utf8')).version,archive='hiveskills-client-'+version+'.tar.gz';
  execFileSync('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','-czf',join(destination,archive),'-C',temporary,...Object.keys(files)],{stdio:'pipe'});chmodSync(join(destination,archive),0o600);
  const artifact={version,url:endpoint.href,sha256:sha(readFileSync(join(destination,archive))),nodeVersion,files};
  writeFileSync(join(destination,'artifact.json'),JSON.stringify({schema:1,product:'@hivemagnus/hive-skills-client',archive,nativeClients:{hiveskills:artifact},published:false},null,2)+'\n',{mode:0o600});
  return artifact;
 }finally{rmSync(temporary,{recursive:true,force:true})}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{const options={};for(let i=2;i<process.argv.length;i+=2){if(!['--output','--url','--node-version'].includes(process.argv[i])||!process.argv[i+1])throw Error('Use --output NEW_DIRECTORY --url PUBLIC_HTTPS_ARTIFACT [--node-version EXACT_TESTED_NODE]');options[process.argv[i].slice(2).replace('-version','Version')]=process.argv[i+1]}if(!options.output||!options.url)throw Error('Explicit output and public artifact URL are required');buildNativeClient(options);console.log('Reviewed native client artifact prepared; add its exact metadata to a publisher-signed Hive release before staging.')}catch(error){console.error(error instanceof Error&&!('stderr'in error)?error.message:'Native client export failed; verify reviewed public inputs');process.exitCode=1}}
