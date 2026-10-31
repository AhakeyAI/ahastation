import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {git,prepareRepository,deliverRepository,runFile,executableCommand} from '../dist-electron/collaboration/workspaces.js';
import {publishFiles,materializeFiles,safeRelative,fetchDelivery} from '../dist-electron/collaboration/git-files.js';
import {prepareMeetingBranch,integrateDelivery} from '../dist-electron/collaboration/integration.js';
import {ensurePullRequest} from '../dist-electron/collaboration/github.js';

test('delivery retry reuses the current PR and a later rework after merge gets one new PR',async()=>{
  let posts=0;let rows=[{html_url:'https://github.com/o/r/pull/1',state:'closed',merged_at:'merged',head:{sha:'a'.repeat(40)},base:{ref:'meeting'}}];
  const api=async(route,body)=>{if(body){posts++;const pr={html_url:'https://github.com/o/r/pull/2',state:'open',merged_at:null,head:{sha:'b'.repeat(40)},base:{ref:'meeting'}};rows=[pr,...rows];return pr;}return rows;};
  const args=['https://github.com/o/r','codex/task','meeting','delivery','summary','b'.repeat(40),api];
  assert.equal(await ensurePullRequest(...args),'https://github.com/o/r/pull/2');assert.equal(await ensurePullRequest(...args),'https://github.com/o/r/pull/2');assert.equal(posts,1);
  rows[0].state='closed';await assert.rejects(ensurePullRequest(...args),/PR 已关闭/);assert.equal(posts,1);
});

test('real Git transport isolates dirty originals, publishes exact selected blobs and verifies meeting before releasing dependencies', {timeout:90000},async()=>{
  const root=await mkdtemp(join(tmpdir(),'station-git-'));const repo=join(root,'original'),bare=join(root,'remote.git'),work=join(root,'workspaces');
  const previousSSH=process.env.GIT_SSH_COMMAND,previousVariant=process.env.GIT_SSH_VARIANT;
  await mkdir(repo);await mkdir(bare);await mkdir(work);
  try {
    await git(bare,['init','--bare']);await git(repo,['init','-b','main']);
    await git(repo,['config','core.autocrlf','false']);
    await git(repo,['config','user.name','Station Fixture']);await git(repo,['config','user.email','fixture@example.invalid']);
    await writeFile(join(repo,'baseline.txt'),'clean baseline\n');await git(repo,['add','.']);await git(repo,['commit','-m','baseline']);
    const base=await git(repo,['rev-parse','HEAD']);const canonical='https://github.com/station-fixture/materials';
    // Git's normal SSH transport is redirected only inside this test to an
    // owned bare repository. Identity, pack transfer and ref checks stay real.
    const transport=join(root,'local-ssh.mjs');await writeFile(transport,`import {spawn} from 'node:child_process';const method=process.argv.some(a=>a.includes('git-receive-pack'))?'receive-pack':'upload-pack';const child=spawn('git',[method,${JSON.stringify(bare)}],{stdio:'inherit'});child.on('exit',code=>process.exit(code??1));`);
    process.env.GIT_SSH_COMMAND='"'+process.execPath+'" "'+transport+'"';process.env.GIT_SSH_VARIANT='ssh';
    await git(repo,['remote','add','origin','git@github.com:station-fixture/materials.git']);await git(repo,['push','-u','origin','main']);
    await writeFile(join(repo,'baseline.txt'),'USER UNCOMMITTED CHANGE\n');
    const meeting=randomUUID(),task=randomUUID();const meetingDir=await prepareMeetingBranch(repo,work,meeting,base);
    assert.equal(await prepareMeetingBranch(repo,work,meeting,base),meetingDir);
    const cwd=await prepareRepository(repo,work,task,base);assert.equal(await readFile(join(cwd,'baseline.txt'),'utf8'),'clean baseline\n');
    await writeFile(join(cwd,'one.txt'),'first');await git(cwd,['add','.']);await git(cwd,['commit','-m','first complete part']);
    await writeFile(join(cwd,'two.txt'),'second');
    let prRequests=0;const delivery=await deliverRepository(cwd,task,meeting,'two files tested',base,async(repository,head,target)=>{
      prRequests++;assert.equal(repository,canonical);assert.equal(target,'codex/station-meeting-'+meeting);return 'https://github.com/station-fixture/materials/pull/1';
    });
    assert.deepEqual(delivery.files.sort(),['one.txt','two.txt']);assert.equal(prRequests,1);
    const before=await git(meetingDir,['rev-parse','HEAD']);
    await assert.rejects(integrateDelivery(meetingDir,delivery.commit,[[process.execPath,'-e','process.exit(2)']]),/验证失败/);
    assert.equal(await git(meetingDir,['rev-parse','HEAD']),before);
    const integrated=await integrateDelivery(meetingDir,delivery.commit,[[process.execPath,'-e',"const f=require('fs');if(f.readFileSync('one.txt','utf8')!=='first'||f.readFileSync('two.txt','utf8')!=='second')process.exit(3);console.log('both files verified')"]]);
    assert.match(integrated.checks[0],/both files verified/);assert.equal(await git(meetingDir,['rev-parse','HEAD']),integrated.commit);
    assert.equal(await readFile(join(repo,'baseline.txt'),'utf8'),'USER UNCOMMITTED CHANGE\n');
    const selected=join(root,'selected.bin');await writeFile(selected,Buffer.from([0,255,11,128]));
    const ref=await publishFiles(repo,work,[selected],base);assert.equal(ref.repository,canonical);
    const paths=await materializeFiles(repo,ref,join(root,'inputs'));assert.deepEqual(await readFile(paths[0]),Buffer.from([0,255,11,128]));
    const fetched=await fetchDelivery(repo,delivery.commit,join(root,'received'),task);assert.equal(await readFile(join(fetched,'two.txt'),'utf8'),'second');
    for(const path of ['../private','C:/private','.git/config','a/../../private','a//b'])assert.throws(()=>safeRelative(path));
    if(process.platform==='win32'){const command=await executableCommand('npm',['--version']);assert.match(command[0],/node[.]exe$/i);assert.match(await runFile('npm',['--version'],cwd),/^\d+[.]\d+/);}
  } finally {if(previousSSH===undefined)delete process.env.GIT_SSH_COMMAND;else process.env.GIT_SSH_COMMAND=previousSSH;if(previousVariant===undefined)delete process.env.GIT_SSH_VARIANT;else process.env.GIT_SSH_VARIANT=previousVariant;await rm(root,{recursive:true,force:true});}
});
