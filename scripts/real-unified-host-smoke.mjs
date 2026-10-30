import {app} from 'electron';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
const root=resolve('runtime/unified-meeting-2026-10-22/real-original-host-'+randomUUID());await mkdir(root,{recursive:true});app.getPath=()=>root;app.getAppPath=()=>process.cwd();
const {UnifiedMeetingHost}=await import('../dist-electron/collaboration/unified-host.js');
const {parseSharedCommand}=await import('../dist-electron/collaboration/production-validation.js');
const a=randomUUID(),b=randomUUID();
const meeting={id:randomUUID(),revision:1,title:'Two independent complete text deliveries',hostAgentId:'codex',hostAuthority:'original-orchestrator',coordinatorDeviceId:a,members:[b],participants:[{deviceId:b,agentId:'file-test',executionCandidate:true}],autoApprovePlan:false,autoAssign:false,plan:[]};
const snapshot={protocol:2,cursor:1,entities:{meeting:[meeting],device:[{id:b,revision:1,name:'Fixture B',online:true,acceptingTasks:true,maxConcurrency:1,activeTasks:0,agents:[{agentId:'file-test',available:true,executionModes:['worker']}]}],project:[],binding:[],message:[],task:[],native:[],history:[],approval:[]}};
const result={pass:false,scope:'Real Codex through original Orchestrator/HostGroup and portable meeting-command; controlled snapshot, no remote worker/cloud/second-computer claim',root,replies:[],plans:[],checkpoints:[]};
const save=()=>writeFile(join(root,'RESULT.json'),JSON.stringify(result,null,2));
const host=new UnifiedMeetingHost(meeting,()=>snapshot,join(root,'host'),{reply:async(text,id)=>{result.replies.push({text,id});await save();},plan:async(tasks,id,brief)=>{parseSharedCommand({protocol:2,requestId:randomUUID(),action:'plan.propose',payload:{meetingId:meeting.id,tasks,brief}});result.plans.push({tasks,id,brief});await save();},checkpoint:async(id,status)=>{result.checkpoints.push({id,status});await save();},session:async value=>{result.session=value;},consult:async()=>{throw new Error('This controlled test has no discussion responder');},control:async()=>{throw new Error('No execution is allowed before human approval');}});
const timer=setTimeout(()=>void host.stop(),150000);
try{
  await host.input({id:randomUUID(),revision:1,text:'请通过原 propose-plan / plan_meeting 提交且仅提交两个独立完整交付的纯文字任务：一份上线检查说明、一份用户操作说明。两者是独立文档，不按电脑或步骤拆。唯一已选入候选是 Fixture B 的 file-test，deviceId='+b+'。每项 sharedTarget={deviceId:"'+b+'",agentId:"file-test",resource:"text",permission:"read-only"}，deps=[]。提供可读目标、做法、步骤和验收条件；只提案，不批准、不执行，不调用本机工具。'});
  if(result.plans.length!==1||result.plans[0].tasks.length!==2||result.plans[0].tasks.some(t=>t.targetDeviceId!==b||t.agentId!=='file-test'||t.resource!=='text'))throw new Error('Original Host did not emit exactly one correct two-delivery plan');
  result.pass=true;
}catch(error){result.error=String(error.message);process.exitCode=1;}
finally{clearTimeout(timer);await host.stop();host.close();await save();console.log(JSON.stringify({pass:result.pass,report:join(root,'RESULT.json'),error:result.error}));}
