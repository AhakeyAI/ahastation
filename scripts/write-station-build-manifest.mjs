import {readdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
async function walk(folder){const result=[];for(const entry of await readdir(folder,{withFileTypes:true})){const file=join(folder,entry.name);if(entry.isDirectory())result.push(...await walk(file));else if(entry.isFile())result.push(file);}return result;}
const paths=[...await walk('electron'),...await walk('src'),'contracts/collaboration/v1.schema.json','contracts/collaboration/v2.schema.json','package.json','electron-builder.json','resources/remote-service.json','vite.config.ts','tsconfig.json','tsconfig.electron.json'];
const files={};for(const file of paths)files[file.replaceAll('\\','/')]=createHash('sha256').update(await readFile(file)).digest('hex');
await writeFile('dist-electron/STATION-SOURCE-MANIFEST.json',JSON.stringify({format:1,files},null,2));
