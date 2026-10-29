import {app} from 'electron';import {mkdir,writeFile} from 'node:fs/promises';import {resolve,join} from 'node:path';import {randomUUID} from 'node:crypto';
const root=resolve('runtime/collaboration-2026-10-21/real-host-'+randomUUID());await mkdir(root,{recursive:true});app.getPath=()=>root;app.getAppPath=()=>process.cwd();
const {SharedCoordinator}=await import('../dist-electron/collaboration/coordinator.js');const {parseSharedCommand}=await import('../dist-electron/collaboration/production-validation.js');
const a=randomUUID(),b=randomUUID(),meeting={id:randomUUID(),revision:1,title:'Two independent documentation deliveries',coordinatorDeviceId:a,members:[b],hostAgentId:'codex',autoApprovePlan:false,autoAssign:false,plan:[]};
const report={pass:false,root,scope:'Real Codex Host generation with a controlled meeting snapshot; no real remote worker or cloud acceptance',replies:[],plans:[],checkpoints:[]};
const save=()=>writeFile(join(root,'RESULT.json'),JSON.stringify(report,null,2));
const host=new SharedCoordinator(meeting,()=>({protocol:2,cursor:0,entities:{meeting:[meeting],device:[{id:b,revision:1,name:'Fixture B',online:true,acceptingTasks:true,maxConcurrency:1,activeTasks:0,agents:[{agentId:'file-test',backendId:'file-test',available:true,executionModes:['worker']}]}],project:[],binding:[],task:[],message:[],native:[],approval:[],history:[],nativecontrol:[]}}),root,{
  reply:async(text,id)=>{report.replies.push({text,id});await save();},
  plan:async(tasks,id)=>{parseSharedCommand({protocol:2,requestId:randomUUID(),action:'plan.propose',payload:{meetingId:meeting.id,tasks}});report.plans.push({tasks,id});await save();},
  checkpoint:async(id,status,thread)=>{report.checkpoints.push({id,status,thread});await save();},
});
const timeout=setTimeout(()=>void host.stop(),120000);
try{
  await host.input({id:randomUUID(),revision:1,text:'请提交两个独立、完整交付的纯文字任务计划：一份上线检查说明，一份使用操作说明。只用会议中已选入的 Fixture B 和 file-test Agent；只提出计划，不执行任务，不调用本机工具，不需要仓库。每个任务包括必要的内容核验要求。'});
  if(!report.plans.length||report.plans[0].tasks.length!==2||report.plans[0].tasks.some(t=>t.targetDeviceId!==b||t.agentId!=='file-test'||t.resource!=='text'))throw new Error('Real Host did not return two executable fixture plans');
  report.pass=true;
}catch(error){report.error=error.message;process.exitCode=1;}
finally{clearTimeout(timeout);await host.stop();host.close();await save();console.log(JSON.stringify({pass:report.pass,report:join(root,'RESULT.json'),error:report.error}));}
