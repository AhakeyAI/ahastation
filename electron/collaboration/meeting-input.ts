import {readFile,mkdir,stat} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {parseAttachmentBuffer} from '../attachments/parse.js';
import {listSkills} from '../skills.js';
import {materializeFiles,type GitFileReference} from './git-files.js';
import type {SharedEntity,StationLocalState} from './production-types.js';

export interface MeetingInput {text:string;images:string[]}
/** Only explicitly attached exact Git references and named installed skills.
 * No project scan, native transcript or credential is added to discussion. */
export async function prepareMeetingInput(message:SharedEntity,state:StationLocalState,folder:string,agentId='codex'):Promise<MeetingInput>{
  let text=String(message.text??'');const images:string[]=[];let remaining=80000;
  const skillNames=Array.from(new Set(Array.from(text.matchAll(/(?:^|\s)\/([\w.-]+)(?=\s|$)/g),m=>m[1])));
  if(skillNames.length){const installed=await listSkills();for(const name of skillNames.slice(0,6)){
    const skill=installed.find(s=>s.name===name);if(!skill)throw new Error('本机未安装所选技能 /'+name+'，请在技能设置准备后重试');
    const body=await readFile(join(skill.path,'SKILL.md'),'utf8');text+='\n用户明确选用的本机技能 /'+name+'（讨论仅使用说明，需要文件或命令时提出正式任务并遵循授权）：\n'+body.slice(0,16000);
  }}
  const refs=(message.attachments??[]) as GitFileReference[];if(refs.length>8)throw new Error('一次最多引用八组明确资料');
  if(refs.length)await mkdir(folder,{recursive:true});
  for(const [index,ref] of refs.entries()){
    const project=state.snapshot.entities.project?.find(p=>(p.repository as {canonicalUrl?:string}|undefined)?.canonicalUrl===ref.repository);
    const binding=project&&state.bindings[project.id];if(!binding?.confirmed||!binding.allowedAgentIds.includes(agentId))throw new Error('读取选定共享资料前，请在本机绑定并授权此 Agent 使用资料仓库：'+ref.repository);
    const paths=await materializeFiles(binding.localRepoRoot,ref,join(folder,String(index)),folder);
    for(const [i,path] of paths.entries()){
      const info=await stat(path);if(info.size>25*1024*1024)throw new Error('选定资料过大，请缩小引用范围');
      const parsed=await parseAttachmentBuffer({name:basename(path),mime:'',sizeBytes:info.size,buffer:await readFile(path)});
      text+='\n明确共享资料 '+ref.repository+'@'+ref.commit+':'+ref.paths[i]+'\n';
      if(parsed.kind==='image'){if(images.length>=8)throw new Error('一次最多提供八张选定图片');images.push(path);text+='[本轮图片输入 '+images.length+']';}
      else {const body=(parsed.text??'').slice(0,Math.max(0,remaining));remaining-=body.length;text+=body;if((parsed.text?.length??0)>body.length)text+='\n[资料超过本轮文字限额，请明确缩小引用]';}
    }
  }
  return {text,images};
}
