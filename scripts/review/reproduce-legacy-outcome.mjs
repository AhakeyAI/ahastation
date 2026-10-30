import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {app} from 'electron';
import {StationService} from '../../dist-electron/collaboration/station-service.js';
import {git,prepareRepository,deliverRepository} from '../../dist-electron/collaboration/workspaces.js';
const root=await mkdtemp(join(tmpdir(),'c5-review-legacy-'));
const oldPath=app.getAppPath,oldEnv={GIT_SSH_COMMAND:process.env.GIT_SSH_COMMAND,GIT_SSH_VARIANT:process.env.GIT_SSH_VARIANT,POCKET_VIBE_STATE_DIR:process.env.POCKET_VIBE_STATE_DIR};
app.getAppPath=()=>process.cwd();process.env.POCKET_VIBE_STATE_DIR=join(root,'native');
const evidence={scope:'Owned local Git transport, fake PR API, no external network',cases:[]};
try {
 const repo=join(root,'repo'),bare=join(root,'bare.git'),work=join(root,'work');for(const dir of [repo,bare,work])await mkdir(dir);
 await git(bare,['init','--bare']);await git(repo,['init','-b','main']);await git(repo,['config','user.name','Isolated Review']);await git(repo,['config','user.email','review@example.invalid']);await writeFile(join(repo,'base.txt'),'base\n');await git(repo,['add','.']);await git(repo,['commit','-m','base']);const base=await git(repo,['rev-parse','HEAD']);
 const transport=join(root,'transport.mjs');await writeFile(transport,`import {spawn} from 'node:child_process';const mode=process.argv.some(a=>a.includes('git-receive-pack'))?'receive-pack':'upload-pack';const p=spawn('git',[mode,${JSON.stringify(bare)}],{stdio:'inherit'});p.on('exit',c=>process.exit(c??1));`);
 process.env.GIT_SSH_COMMAND='"'+process.execPath.replaceAll('\\','/')+'" "'+transport.replaceAll('\\','/')+'"';process.env.GIT_SSH_VARIANT='ssh';await git(repo,['remote','add','origin','git@github.com:isolated-review/legacy-outcome.git']);await git(repo,['push','origin','HEAD:refs/heads/codex/station-meeting-m']);
 for(const outcome of ['unknown',undefined]) {
  const name=outcome??'missing',cwd=await prepareRepository(repo,work,name,base);await writeFile(join(cwd,'partial.txt'),'partial retained in old receipt\n');
  const s=new StationService(join(root,'profile-'+name));await s.storage.load();s.localReady=true;s.connected=true;s.pump=async()=>{};const sent=[];s.send=async(a,p)=>{sent.push({a,p});return {};};let prs=0;
  const t={id:name,revision:1,meetingId:'m',attemptId:'attempt-'+name,targetDeviceId:'A',agentId:'codex',projectId:'p',resource:'repository',permission:'workspace-write',baseCommit:base,status:'executed',stopRequested:false,inputs:[],dependencies:[]};
  await s.storage.update(state=>{state.deviceId='A';state.allowedAgents=['codex'];state.bindings.p={projectId:'p',deviceId:'A',confirmed:true,revision:1,allowedAgentIds:['codex'],localRepoRoot:repo,taskWorkspaceRoot:work};state.snapshot={protocol:2,cursor:0,entities:{project:[{id:'p',revision:1,repository:{canonicalUrl:'https://github.com/isolated-review/legacy-outcome'}}],task:[t],device:[]}};state.receipts[name]={taskId:name,attemptId:t.attemptId,status:'executed',cwd,bindingRevision:1,output:['old output'],exitConfirmed:true,executionInvoked:true,taskSnapshot:t,...(outcome?{turnOutcome:outcome}:{})};});
  s.repositoryDelivery=(task,r,summary)=>deliverRepository(r.cwd,task.id,task.meetingId,summary,task.baseCommit,async()=>{prs++;return 'https://example.invalid/mock-pr';},()=>s.authorizeDelivery(task,r),(args,phase)=>s.runDeliveryGit(task,r,r.cwd,args,phase));
  await s.doPump();await Promise.allSettled([...s.objectJobs.values()]);await Promise.allSettled([...s.deliveries.values()]);
  const r=s.storage.read().receipts[name],refs=await git(bare,['show-ref','--heads']);const result={outcome:name,status:r.status,localOutcome:r.turnOutcome??null,commitChanged:(await git(cwd,['rev-parse','HEAD']))!==base,pushed:refs.includes('refs/heads/codex/station-task-'+name),prCalls:prs,publishedOutcome:sent.find(e=>e.a==='task.event'&&e.p.status==='delivered')?.p.turnOutcome??null,agentInvoked:false};evidence.cases.push(result);
 }
 assert.equal(evidence.cases[0].pushed,false);assert.equal(evidence.cases[1].pushed,true);assert.equal(evidence.cases[1].publishedOutcome,'completed');
 evidence.confirmed='Missing legacy outcome automatically creates commit, pushes and reports completed; explicit unknown is blocked';
 await mkdir('runtime/review-legacy-outcome',{recursive:true});await writeFile('runtime/review-legacy-outcome/RESULT.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}finally{app.getAppPath=oldPath;for(const [key,value]of Object.entries(oldEnv))if(value===undefined)delete process.env[key];else process.env[key]=value;await rm(root,{recursive:true,force:true});}
