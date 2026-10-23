import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
import {mkdir,writeFile,readFile} from 'node:fs/promises';import {join,resolve} from 'node:path';import {randomUUID} from 'node:crypto';
import {app,safeStorage} from 'electron';
const root=resolve(process.env.STATION_EVIDENCE_DIR??'runtime/unified-meeting-2026-10-22','real-unified-two-stations-'+randomUUID());await mkdir(root,{recursive:true});
app.getPath=()=>root;app.getAppPath=()=>process.cwd();safeStorage.isEncryptionAvailable=()=>true;
safeStorage.encryptString=s=>Buffer.from('isolated-fixture:'+s);safeStorage.decryptString=b=>b.toString().slice(17);
process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK='1';process.env.POCKET_VIBE_STATE_DIR=join(root,'native-state');
const {StationService}=await import('../dist-electron/collaboration/station-service.js');
const {updateRemoteControlFields,flushSettingsWrites}=await import('../dist-electron/store.js');
const report={pass:false,root,scope:'Two production Station services and local HTTP/WSS Hub, real Codex through original HostGroup/Orchestrator plus worker and independent discussion, manual plan approval plus fixed-target assignment. Electron API and secure storage are fixtures; no actual second PC, cloud or GitHub PR claim.'};
const child=spawn(process.env.COLLABORATION_PYTHON,['services/remote/tests/station_collaboration_fixture.py'],{stdio:['pipe','pipe','pipe'],windowsHide:true});let stderr='';child.stderr.on('data',v=>{stderr=(stderr+v).slice(-3000);});let a,b;
const until=async(fn,label,seconds=150)=>{const deadline=Date.now()+seconds*1000;while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw new Error(label);};
const command=(action,payload)=>a.action('command',{action,payload});
try{
  const lines=createInterface({input:child.stdout});const info=await new Promise((done,reject)=>{const timer=setTimeout(()=>reject(new Error('Local Hub startup timed out')),20000);lines.on('line',line=>{try{const m=JSON.parse(line);if(m.ready){clearTimeout(timer);done(m);}}catch{}});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Local Hub exited'));});});
  await updateRemoteControlFields(()=>({enabled:true,mode:'public',serviceUrl:info.url,ownerId:info.owner,controlToken:info.token}));
  a=new StationService(join(root,'A'));b=new StationService(join(root,'B'));await a.initialize();await b.initialize();
  await until(()=>a.view().connected&&b.view().connected,'Both real WSS connections must be online',30);
  for(const [service,name] of [[a,'A'],[b,'B']])await service.action('configure',{config:{...service.view().config,name,acceptingTasks:true,maxConcurrency:1},allowedAgents:['codex']});
  const meeting=await command('meeting.create',{title:'Real model whole delivery',members:[b.view().deviceId],participants:[{deviceId:b.view().deviceId,agentId:'codex',executionCandidate:true}],hostAuthority:'original-orchestrator',hostAgentId:'codex',autoApprovePlan:false,autoAssign:true});
  await command('message.send',{meetingId:meeting.id,text:'请只规划一个完整的纯文字任务，由会议内的 B 设备 codex Agent 交付一份简洁中文操作说明完整正文，必须包含两个标题“AhaStation 上线核验”和“AhaStation 双机使用”，每节至少三条具体操作，最后一行“STATION-REAL-END-TO-END-OK”。成果在回复中直接给出，不创建文件，不读取项目，不联网，不调用工具。一个任务完成全部内容和文字核验；resource=text、permission=read-only、inputs=[]、dependencies=[]。计划批准由会议处理，不把等待批准的元指令写进任务objective。'});
  const current=()=>a.view().snapshot.entities.meeting.find(m=>m.id===meeting.id);
  await until(()=>current()?.plan?.length===1,'Real Host must publish one complete executable plan');
  if(current().planApproved||a.view().snapshot.entities.task?.length)throw new Error('Plan executed before explicit user decision');
  await command('plan.decide',{meetingId:meeting.id,expectedPlanVersion:Number(current().planVersion??0),approved:true});
  await until(()=>a.view().snapshot.entities.task?.some(t=>t.meetingId===meeting.id&&t.status==='running'),'Real worker should start');
  const discussion=await command('message.send',{meetingId:meeting.id,targetDeviceId:b.view().deviceId,targetAgentId:'codex',text:'只做独立专家讨论，不读取文件，不派任务，也不要假称拥有正在执行任务的完整上下文。请简短回答：SHARED-DISCUSSION-CONTEXT-OK'});
  await until(()=>[a,b].every(s=>s.view().snapshot.entities.task?.some(t=>t.meetingId===meeting.id&&t.status==='delivered')),'Real worker must complete the approved delivery on both snapshots');
  const task=a.view().snapshot.entities.task.find(t=>t.meetingId===meeting.id);const summary=String(task.delivery?.summary??'');
  if(task.targetDeviceId!==b.view().deviceId||!task.exitConfirmed||!summary.trimEnd().endsWith('STATION-REAL-END-TO-END-OK')||!summary.includes('AhaStation 上线核验')||!summary.includes('AhaStation 双机使用')||summary.length<150||(summary.match(/^\s*(?:[-*]|\d+[.、])/gm)??[]).length<6||/请回复.{0,12}(批准|确认)|批准后.{0,6}执行/.test(summary))throw new Error('Real delivered content or execution identity does not match; a pending plan is not delivery');
  const receipt=JSON.parse(await readFile(join(root,'B/station-v2.json'),'utf8')).receipts[task.id];
  if(!receipt.executionInvoked||receipt.status!=='delivered'||!receipt.exitConfirmed)throw new Error('Receiver did not persist actual execution and exit');
  await until(()=>a.view().snapshot.entities.message.some(m=>m.replyTo===discussion.id),'Independent expert discussion must reply without dispatching a task');
  const savedB=JSON.parse(await readFile(join(root,'B/station-v2.json'),'utf8'));
  const discussionThread=savedB.discussionThreads?.[meeting.id+':codex'];
  if(!discussionThread||discussionThread===receipt.nativeThreadId||a.view().snapshot.entities.task.filter(t=>t.meetingId===meeting.id).length!==1)throw new Error('Discussion context or task identity was mixed');
  await a.action('delivery.review',{taskId:task.id,evidence:'This executable integration script checked both expected headings, six concrete steps, final marker and same result on both Stations.'});
  report.discussion={id:discussion.id,threadId:discussionThread,separateFromTask:true};
  report.pass=true;report.task={id:task.id,attemptId:task.attemptId,deviceId:task.targetDeviceId,status:task.status,exitConfirmed:task.exitConfirmed,nativeThreadId:receipt.nativeThreadId,summary};
  report.sameResultOnB=b.view().snapshot.entities.task.some(t=>t.id===task.id&&t.status==='delivered');
}catch(error){report.error=error.stack;report.diagnostics={a:a?.view(),b:b?.view(),stderr};process.exitCode=1;}
finally{
  const cleanup=await Promise.allSettled([a?.shutdown(),b?.shutdown()]);report.cleanup=cleanup.map(r=>r.status==='fulfilled'?r.value:String(r.reason));
  if(cleanup.some(r=>r.status==='rejected'||r.value===false)){report.pass=false;process.exitCode=1;}
  for(const service of [a,b])if(service){clearInterval(service.nativeTimer);clearInterval(service.recoveryTimer);service.connection?.stop();}
  await flushSettingsWrites();child.stdin.end('\n');if(child.exitCode===null)await new Promise(r=>child.once('exit',r));
  await writeFile(join(root,'RESULT.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({pass:report.pass,report:join(root,'RESULT.json'),error:report.error}));
}
