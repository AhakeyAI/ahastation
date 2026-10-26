import {execFileSync} from 'node:child_process';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
async function walk(folder){const result=[];for(const entry of await readdir(folder,{withFileTypes:true})){const file=join(folder,entry.name);if(entry.isDirectory())result.push(...await walk(file));else if(entry.isFile())result.push(file);}return result;}
const paths=[...await walk('electron'),...await walk('src'),'contracts/collaboration/v1.schema.json','contracts/collaboration/v2.schema.json','package.json','package-lock.json','electron-builder.json','resources/remote-service.json','vite.config.ts','tsconfig.json','tsconfig.electron.json'];
const files={};for(const file of paths)files[file.replaceAll('\\','/')]=createHash('sha256').update(await readFile(file)).digest('hex');
await writeFile('dist-electron/STATION-SOURCE-MANIFEST.json',JSON.stringify({format:2,gitHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),branch:execFileSync('git',['branch','--show-current'],{encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),sourceDigest:createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b))))).digest('hex'),dependencyLockSha256:createHash('sha256').update(await readFile('package-lock.json')).digest('hex'),codexRuntime:'0.164.0',files},null,2));
