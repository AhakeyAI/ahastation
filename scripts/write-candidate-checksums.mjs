import {readFile,writeFile,mkdir,copyFile,readdir} from 'node:fs/promises';import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';import {join,resolve} from 'node:path';import {homedir} from 'node:os';
const root=resolve('release/collaboration-candidate');const runtime=resolve('runtime/collaboration-2026-10-21');
await mkdir(join(root,'verification'),{recursive:true});
const evidence={
  'baseline-comparison.json':'baseline-comparison.json','installer-manifest.json':'installer-manifest.json','package-verification.json':'package-verification.json',
  'deployment-verification.json':'deployment-verification.json','cloud-readonly-check.json':'cloud-readonly-check.json',
  'cloud-health-recheck.json':'cloud-health-recheck.json','cloud-ready-recheck.json':'cloud-ready-recheck.json','cloud-v2-recheck.json':'cloud-v2-recheck.json',
  'packaged-startup.json':'gui-07fc939e-8b39-4d84-9ae0-f10d8a263ac4/RESULT.json',
  'installer-startup.json':'gui-fd12ef02-9a98-4e6d-9480-05ef5913036a/RESULT.json',
  'real-codex-worker.json':'real-codex-42edfd05-dbe9-41cb-bcb6-af04fdcc0be5/RESULT.json',
  'real-codex-host.json':'real-host-699f6783-57e4-48db-be54-aef7ce99a63c/RESULT.json',
  'real-model-chain-content.json':'real-two-stations-af23b697-3613-41a8-9e50-fbbbff57e58a/CONTENT-VALIDATION.json',
  'mysql-rehearsal.json':'mysql-portable/rehearsal-9f0b1e96-9841-4015-b593-c091e9d17ab4/RESULT.json',
};
for(const [target,source] of Object.entries(evidence))await copyFile(join(runtime,source),join(root,'verification',target));
await copyFile(join(homedir(),'.pocket-vibe/remote/tasks/codex/682c667b-488d-4853-8e3d-fba827ad9f9d/result.json'),join(root,'verification/real-model-http429.json'));
await copyFile('docs/collaboration/CANDIDATE_DELIVERY_2026-10-21.md',join(root,'DELIVERY_REPORT.md'));
async function sha(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
const original=join(root,'win-unpacked');const extracted=join(runtime,'nsis-payload-final/win-unpacked');const compared={};
for(const file of ['AhaStation.exe','resources/app.asar','resources/station-native/station-native.exe']){
  const a=await sha(join(original,file)),b=await sha(join(extracted,file));if(a!==b)throw new Error('Actual installer payload differs: '+file);compared[file]=a;
}
await writeFile(join(root,'verification/installer-payload-comparison.json'),JSON.stringify({pass:true,files:compared},null,2));
const pkg=JSON.parse(await readFile('package.json','utf8'));const files={};
const names=[`AhaStation Setup ${pkg.version}.exe`,`AhaStation Setup ${pkg.version}.exe.blockmap`,'DELIVERY_REPORT.md','source/ahastation-collaboration-source.zip','deployment/ahastation-hub-source.zip','deployment/ahastation-wss-probe-source.zip',...(await readdir(join(root,'verification'))).filter(n=>n.endsWith('.json')).map(n=>'verification/'+n)];
for(const file of names)files[file]=await sha(join(root,file));
await writeFile(join(root,'CHECKSUMS.json'),JSON.stringify({format:1,version:pkg.version,platform:'windows-x64',signed:false,files},null,2));
console.log(JSON.stringify({pass:true,root,files:Object.keys(files).length,installerPayloadIdentical:true}));
