import {extractFile,listPackage} from '@electron/asar';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {join,resolve,normalize} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {CODEX_RUNTIME} from '../dist-electron/backends/codex-runtime.js';
const folder=resolve(process.argv[2]??'release/collaboration-candidate');const resources=join(folder,'win-unpacked/resources');const archive=join(resources,'app.asar');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const embedded=file=>extractFile(archive,normalize(file));
const source=JSON.parse(embedded('dist-electron/STATION-SOURCE-MANIFEST.json').toString('utf8'));
for(const [file,hash] of Object.entries(source.files))if(sha(await readFile(file))!==hash)throw new Error('Source changed after candidate build: '+file);
const required=['package.json','dist/index.html','dist/icon-96.png','contracts/collaboration/v1.schema.json','contracts/collaboration/v2.schema.json','contracts/runtime/codex.json','dist-electron/runtime/codex.json','dist-electron/backends/codex-runtime.js',
  'dist-electron/bootstrap.js','dist-electron/main.js','dist-electron/preload.cjs',
  'node_modules/fast-sha256/sha256.js',
  ...['station-service','connection','production-validation','native-helper','coordinator','unified-host',
    'host-plan-outcome','delivery-identity','unified-policy','delivery-report','meeting-input','git-files',
    'integration','workspaces'].map(n=>'dist-electron/collaboration/'+n+'.js')];
for(const file of required.filter(p=>p!=='package.json'))if(sha(embedded(file))!==sha(await readFile(file)))throw new Error('Packaged source is stale: '+file);
const manifest=JSON.parse(await readFile(join(resources,'station-native/SOURCE-MANIFEST.json'),'utf8'));
for(const [file,hash] of Object.entries(manifest.files))if(sha(await readFile(file))!==hash)throw new Error('Bundled receiver source is stale: '+file);
for(const [file,hash] of Object.entries(manifest.payloadFiles))if(sha(await readFile(join(resources,'station-native',file)))!==hash)throw new Error('Bundled receiver payload differs: '+file);
if(sha(await readFile('services/remote/requirements-station-native.txt'))!==manifest.requirementsSha256)throw new Error('Native build requirements changed');
const selfTest=execFileSync(join(resources,'station-native/station-native.exe'),[],{input:'{"operation":"self-test"}\n',encoding:'utf8',windowsHide:true,timeout:30000});
if(!selfTest.split('\n').some(line=>{try{const m=JSON.parse(line);return m.type==='result'&&m.value?.ok&&m.value?.frozen&&m.value?.protocol===2;}catch{return false;}}))throw new Error('Packaged receiver did not pass its self-test');
const codex=join(resources,'app.asar.unpacked/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
const version=execFileSync(codex,['--version'],{encoding:'utf8',windowsHide:true,timeout:15000}).trim();if(version!=='codex-cli '+CODEX_RUNTIME.bundled)throw new Error('Unexpected Codex protocol runtime');
async function walk(root){const found=[];for(const e of await readdir(root,{withFileTypes:true})){const p=join(root,e.name);if(e.isDirectory())found.push(...await walk(p));else if(e.isFile())found.push(p);}return found;}
const compiled=[...await walk('dist'),...await walk('dist-electron')];for(const file of compiled)if(sha(embedded(file))!==sha(await readFile(file)))throw new Error('Installed compiled payload differs: '+file);
const sdk=JSON.parse(embedded('node_modules/@openai/codex-sdk/package.json').toString('utf8'));if(sdk.version!==CODEX_RUNTIME.bundled)throw new Error('Packaged SDK does not match the bundled runtime');
if(JSON.stringify(source.codexRuntimeContract)!==JSON.stringify(CODEX_RUNTIME)||JSON.stringify(manifest.codexRuntimeContract)!==JSON.stringify(CODEX_RUNTIME))throw new Error('Packaged runtime contracts disagree');
const files=listPackage(archive);if(files.some(p=>/^[/\\]runtime[/\\]/.test(p)||p.includes('private-fixture.json')||p.endsWith('/station-v2.json')))throw new Error('Local test state entered the package');
const pkg=JSON.parse(extractFile(archive,'package.json').toString('utf8'));if(pkg.main!=='dist-electron/bootstrap.js')throw new Error('Profile bootstrap entry was not packaged');
if(pkg.version!==JSON.parse(await readFile('package.json','utf8')).version)throw new Error('Candidate version is stale');
const report={pass:true,verifiedAt:new Date().toISOString(),folder,platform:'windows-x64',version:pkg.version,main:pkg.main,requiredFiles:required.length,compiledFiles:compiled.length,gitHead:source.gitHead,dirty:source.dirty,sourceDigest:source.sourceDigest,dependencyLockSha256:source.dependencyLockSha256,asarEntries:files.length,receiver:{frozen:true,protocol:2,python:manifest.python,machine:manifest.machine,sourceFiles:Object.keys(manifest.files).length,payloadFiles:Object.keys(manifest.payloadFiles).length,sourceDigest:manifest.sourceDigest,payloadDigest:manifest.payloadDigest,pyinstaller:manifest.pyinstallerVersion},codex:version,sourceFreshness:true,localTestStateExcluded:true};
const evidence=process.argv[3]??'runtime/collaboration-2026-10-21';await mkdir(evidence,{recursive:true});await writeFile(join(evidence,'package-verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
