/** Actual React in isolated headless Chrome. Explicit DEV fixture, no model/cloud. */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createServer} from 'vite';
import {mkdir} from 'node:fs/promises';
import {createServer as reserveSocket} from 'node:net';
import {chromium} from 'playwright';
let server,browser,origin;
before(async()=>{
  const reservation=reserveSocket();
  await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
  const port=reservation.address().port;
  await new Promise(r=>reservation.close(r));
  server=await createServer({
    cacheDir:process.env.STATION_VITE_CACHE_DIR,
    server:{watch:null,host:'127.0.0.1',port,strictPort:true,open:false},
    logLevel:'error',
  });
  await server.listen();
  origin='http://127.0.0.1:'+server.httpServer.address().port;
  browser=await chromium.launch({executablePath:process.env.STATION_CHROME,headless:true});
  // Warm-up: the first load pays Vite's cold dependency pre-bundling, and on macOS/Windows CI runners the page that
  // triggered it can stay broken while a fresh page renders. Retry on fresh pages so no single test inherits it.
  for(let attempt=1;;attempt++){const warm=await browser.newPage({viewport:{width:1600,height:1100}});try{await warm.goto(origin+'/?ui-fixture=unified',{waitUntil:'domcontentloaded',timeout:90000});await warm.getByRole('button',{name:'对话',exact:true}).first().waitFor({timeout:90000});break;}catch(error){if(attempt>=3)throw error;}finally{await warm.close();}}
},{timeout:400000});
after(async()=>{await browser?.close();await server?.close();});
async function page(){
  const p=await browser.newPage({viewport:{width:1600,height:1100}});
  const errors=[];
  p.on('pageerror',error=>errors.push(error.message));
  p.on('requestfailed',request=>errors.push(request.url()+': '+request.failure()?.errorText));
  try{
    await p.goto(origin+'/?ui-fixture=unified',{waitUntil:'domcontentloaded',timeout:60000});
    await p.getByRole('button',{name:'对话',exact:true}).first().click({timeout:60000});
    return p;
  }catch(error){
    console.error('Unified fixture startup failed:',errors,await p.locator('body').innerText().catch(()=>'<unavailable>'));
    await p.close();
    throw error;
  }
}
async function delaySends(p){await p.evaluate(()=>{window.__sends=[];const api=window.vibeMeet.collaboration,original=api.request;api.request=async(a,p)=>{if(a==='command'&&p?.action==='message.send'){window.__sends.push(p);await new Promise(r=>setTimeout(r,700));}return original(a,p);};});}
async function capture(p,name){if(process.env.STATION_UI_EVIDENCE_DIR){await mkdir(process.env.STATION_UI_EVIDENCE_DIR,{recursive:true});await p.screenshot({path:join(process.env.STATION_UI_EVIDENCE_DIR,name+'.png')});}}

test('unified fixture supplies the rate-limit subscription API on first navigation',async()=>{
  const p=await page();
  try{
    const result=await p.evaluate(async()=>{
      const api=window.vibeMeet.rateLimits;
      const unsubscribe=api.onUpdate(()=>{});
      const subscription=typeof unsubscribe;
      unsubscribe();
      return {subscription,initial:await api.get(),refreshed:await api.refresh()};
    });
    assert.deepEqual(result,{
      subscription:'function',
      initial:{ok:true,state:{providers:[],refreshing:false}},
      refreshed:{ok:true,state:{providers:[],refreshing:false}},
    });
  }finally{await p.close();}
});
test('F2 actual React rapid clicks submit once',async()=>{const p=await page();try{await delaySends(p);await p.locator('textarea').fill('只发一次');await p.locator('.drawer-send-icon').evaluate(b=>{b.click();b.click();});await p.waitForTimeout(1000);assert.equal(await p.evaluate(()=>window.__sends.length),1);}finally{await p.close();}});
test('F2 actual React old response preserves text typed while sending',async()=>{const p=await page();try{await delaySends(p);const input=p.locator('textarea');await input.fill('上一条');await p.locator('.drawer-send-icon').click();await input.fill('下一条未发送文字');await p.waitForTimeout(1000);assert.equal(await input.inputValue(),'下一条未发送文字');}finally{await p.close();}});
test('S04/S06 actual Enter is synchronous, and Hub confirmation enables the next identical message before model completion',async()=>{const p=await page();try{await delaySends(p);const input=p.locator('textarea');await input.fill('相同正文');await input.press('Enter');await input.press('Enter');await p.waitForTimeout(1000);assert.equal(await p.evaluate(()=>window.__sends.length),1);await input.fill('相同正文');await input.press('Enter');await p.waitForTimeout(1000);const sends=await p.evaluate(()=>window.__sends);assert.equal(sends.length,2);assert.notEqual(sends[0].requestId,sends[1].requestId);}finally{await p.close();}});
test('S05/S08 actual attachment staging freezes the selected mention and preserves next text and new attachment',async()=>{const p=await page();try{
  await p.locator('.unified-materials summary').click();await p.locator('.unified-materials select').first().selectOption('fixture-materials');
  await p.evaluate(()=>{window.__sends=[];window.__stages=[];const api=window.vibeMeet.collaboration,original=api.request;api.request=async(a,p)=>{if(a==='files.stage'){window.__stages.push(p);await new Promise(r=>setTimeout(r,900));}if(a==='command'&&p.action==='message.send')window.__sends.push(p);return original(a,p);};});
  const input=p.locator('textarea');await input.fill('@');await input.press('ArrowDown');await input.press('Enter');const firstText=await input.inputValue();assert.match(firstText,/电脑 B/);
  await p.locator('input[type=file]').setInputFiles({name:'first.txt',mimeType:'text/plain',buffer:Buffer.from('first')});await p.getByRole('button',{name:'移除 first.txt',exact:true}).waitFor();await p.locator('.drawer-send-icon').click();await input.fill('下一条正文');
  await p.locator('input[type=file]').setInputFiles({name:'next.txt',mimeType:'text/plain',buffer:Buffer.from('next')});await p.getByRole('button',{name:'移除 next.txt',exact:true}).waitFor();await p.getByRole('button',{name:'夹具：设备改名',exact:true}).click();await p.waitForTimeout(1200);
  const sends=await p.evaluate(()=>window.__sends);assert.equal(sends.length,1);assert.equal(sends[0].payload.text,firstText);assert.equal(sends[0].payload.targetDeviceId,'22222222-2222-4222-8222-222222222222');assert.deepEqual(sends[0].payload.attachments[0].paths,['first.txt']);assert.equal(await input.inputValue(),'下一条正文');assert.equal(await p.getByRole('button',{name:'移除 next.txt',exact:true}).count(),1);assert.equal(await p.getByRole('button',{name:'移除 first.txt',exact:true}).count(),0);
}finally{await p.close();}});
test('S08 actual offline mention rejects without falling back to Host or clearing input',async()=>{const p=await page();try{await delaySends(p);const input=p.locator('textarea');await input.fill('@');await input.press('ArrowDown');await input.press('Enter');const text=await input.inputValue();await p.getByRole('button',{name:'夹具：切换离线',exact:true}).click();await p.locator('.drawer-send-icon').click();await p.waitForTimeout(100);assert.equal(await input.inputValue(),text);assert.equal(await p.evaluate(()=>window.__sends.length),0);}finally{await p.close();}});
test('S05 actual attachment preparation failure preserves new edits and cannot generate a message',async()=>{const p=await page();try{await p.locator('.unified-materials summary').click();await p.locator('.unified-materials select').first().selectOption('fixture-materials');await p.evaluate(()=>{window.__sends=[];const api=window.vibeMeet.collaboration,original=api.request;api.request=async(a,p)=>{if(a==='files.stage'){await new Promise(r=>setTimeout(r,700));return {ok:false,error:'injected staging failure'};}if(a==='command'&&p.action==='message.send')window.__sends.push(p);return original(a,p);};});const input=p.locator('textarea');await input.fill('旧输入');await p.locator('input[type=file]').setInputFiles({name:'failed.txt',mimeType:'text/plain',buffer:Buffer.from('test')});await p.getByRole('button',{name:'移除 failed.txt',exact:true}).waitFor();await p.locator('.drawer-send-icon').click();await input.fill('失败期间的新文字');await p.waitForTimeout(1000);assert.equal(await input.inputValue(),'失败期间的新文字');assert.equal(await p.getByRole('button',{name:'移除 failed.txt',exact:true}).count(),1);assert.equal(await p.evaluate(()=>window.__sends.length),0);}finally{await p.close();}});
test('S07 actual pending submission reconciles its original ID and releases only the submitted input version',async()=>{const p=await page();try{
  await p.evaluate(()=>{window.__pending=null;window.__sends=[];window.__reconciles=[];const api=window.vibeMeet.collaboration,original=api.request;api.request=async(a,p)=>{if(a==='command'&&p.action==='message.send'){window.__sends.push(p);await original(a,p);window.__pending={requestId:p.requestId,meetingId:p.payload.meetingId,text:p.payload.text,status:'pending'};return {ok:true,value:{pending:true}};}if(a==='message.reconcile'){window.__reconciles.push(p.requestId);window.__pending={...window.__pending,status:'accepted'};return {ok:true,value:{}};}const reply=await original(a,p);if(a==='status')reply.value.messageSubmissions=window.__pending?[window.__pending]:[];return reply;};});
  const input=p.locator('textarea');await input.fill('已保存但响应丢失');await p.locator('.drawer-send-icon').click();await p.locator('.unified-error-summary summary').first().click();await p.getByRole('button',{name:'核对／补投原提交',exact:true}).waitFor();await input.fill('核对期间的新输入');await p.getByRole('button',{name:'核对／补投原提交',exact:true}).click();await p.waitForTimeout(150);const result=await p.evaluate(()=>({sends:window.__sends,reconciles:window.__reconciles}));assert.equal(result.sends.length,1);assert.deepEqual(result.reconciles,[result.sends[0].requestId]);assert.equal(await input.inputValue(),'核对期间的新输入');assert.equal(await p.locator('.drawer-send-icon').isEnabled(),true);
}finally{await p.close();}});
test('H09 actual original message reconciliation shows recent cause, uses the same identity and preserves new edits',async()=>{const p=await page();try{
 await p.evaluate(async()=>{const api=window.vibeMeet.collaboration,original=api.request;window.__recovered=false;window.__reconciles=[];api.request=async(a,p)=>{if(a==='execution.reconcile'){window.__reconciles.push(p);window.__recovered=true;return {ok:true,value:{}};}const r=await original(a,p);if(a==='status'){const view=r.value;view.snapshot.entities.message=[{id:'original-expert',revision:1,meetingId:'ui-unified-meeting',route:'agent',sourceDeviceId:view.deviceId,targetDeviceId:view.deviceId,targetAgentId:'codex',text:'原消息核对测试',createdAt:1,stopRequested:true,executionStatus:window.__recovered?'completed':'reconcile',exitConfirmed:window.__recovered,turnOutcome:window.__recovered?'completed':undefined}];view.reconciliation={'input:original-expert':{reason:window.__recovered?'':'确定的原组件核对错误',history:['确定的原组件核对错误']}};}return r;};await (await import('/src/lib/unified-meeting-store.ts')).refreshShared();});
 const card=p.locator('.msg').filter({hasText:'原消息核对测试'});await card.getByText(/停止尚未确认/).waitFor();assert.match(await card.innerText(),/确定的原组件核对错误/);
 const input=p.locator('textarea');await input.fill('新的未发送正文');await p.locator('input[type=file]').setInputFiles({name:'next.txt',mimeType:'text/plain',buffer:Buffer.from('kept')});await p.getByRole('button',{name:'移除 next.txt',exact:true}).waitFor();await card.getByRole('button',{name:'重新核对',exact:true}).click();
 await card.getByText('本轮正常结束；停止后尚未开始的补充与后续执行等待明确继续。',{exact:true}).waitFor();assert.equal(await card.getByRole('button',{name:'重新核对',exact:true}).count(),0);assert.equal(await card.getByText(/确定的原组件核对错误/).count(),0);assert.equal(await input.inputValue(),'新的未发送正文');assert.equal(await p.getByRole('button',{name:'移除 next.txt',exact:true}).count(),1);assert.deepEqual(await p.evaluate(()=>window.__reconciles),[{messageId:'original-expert'}]);
}finally{await p.close();}});
test('H09 actual task card distinguishes normal end, stop intent and delivery pending without starting work',async()=>{const p=await page();try{
 await p.evaluate(async()=>{window.__controls=[];const api=window.vibeMeet.collaboration,original=api.request;api.request=async(a,p)=>{if(a==='command')window.__controls.push(p);const r=await original(a,p);if(a==='status')r.value.snapshot.entities.task=[{id:'normal-stopped',revision:1,meetingId:'ui-unified-meeting',title:'原正常轮次成果',objective:'original',attemptId:'original-attempt',targetDeviceId:r.value.deviceId,agentId:'codex',resource:'text',status:'delivery-pending',turnOutcome:'completed',stopRequested:true,exitConfirmed:true,pendingFollowups:[],dependencies:[],deliveryError:'推送回应待核对'}];return r;};await(await import('/src/lib/unified-meeting-store.ts')).refreshShared();});
 await p.getByRole('button',{name:'原正常轮次成果',exact:true}).first().click();const card=p.locator('.unified-inspector');await card.getByText('本轮正常结束；停止后尚未开始的补充与后续执行等待明确继续。',{exact:true}).waitFor();assert.match(await card.innerText(),/交付待处理.*推送回应待核对/s);await card.getByRole('button',{name:'补充／继续',exact:true}).click();assert.equal(await card.getByRole('button',{name:'核对后继续原任务',exact:true}).count(),1);assert.equal(await p.evaluate(()=>window.__controls.length),0);
}finally{await p.close();}});

async function commands(p){
  await p.evaluate(()=>{window.__commands=[];const api=window.vibeMeet.collaboration,original=api.request;
    api.request=async(a,p)=>{if(a==='command')window.__commands.push(p);return original(a,p);};});
}
async function status(p){return p.evaluate(async()=> (await window.vibeMeet.collaboration.request('status')).value);}
async function noPlanApproval(p){
  assert.equal(await p.locator('.plan-modal').count(),0);
  assert.equal(await p.getByRole('button',{name:/审阅可读计划|批准计划|拒绝计划/}).count(),0);
  assert.equal(await p.getByLabel('自动批准后续计划',{exact:true}).count(),0);
}
test('direct plan baseline wait survives identical refresh without changing the approved commit',async()=>{
  const p=await page();try{
    await commands(p);await p.getByRole('button',{name:'夹具：依赖基线',exact:true}).click();
    await p.getByText(/计划 · 2 项 · 已开始 1 项 · 1 项等待新基线/).waitFor();
    await p.getByRole('button',{name:'夹具：相同快照',exact:true}).click();
    await p.locator('.user-tasks-panel').getByText('等待新基线后开始',{exact:true}).waitFor();
    const view=await status(p);assert.equal(view.snapshot.entities.meeting[0].plan[1].baseCommit,'a'.repeat(40));
    assert.equal(view.snapshot.entities.task.length,1);await noPlanApproval(p);
    assert.deepEqual(await p.evaluate(()=>window.__commands),[]);
  }finally{await p.close();}
});
test('read-only plan refresh and device changes preserve unsent conversation',async()=>{
  const p=await page();try{
    await commands(p);await p.locator('textarea').fill('用户尚未发送的要求');
    for(const label of ['夹具：相同快照','夹具：设备改名','夹具：切换离线','夹具：普通进度'])
      await p.getByRole('button',{name:label,exact:true}).click();
    await p.locator('.user-tasks-panel').getByText(/改名后的中文电脑/).waitFor();
    assert.equal(await p.locator('textarea').inputValue(),'用户尚未发送的要求');
    await noPlanApproval(p);assert.deepEqual(await p.evaluate(()=>window.__commands),[]);
  }finally{await p.close();}
});
test('new plan snapshot updates read-only progress without submitting an approval',async()=>{
  const p=await page();try{
    await commands(p);await p.getByRole('button',{name:'夹具：新计划',exact:true}).click();
    await p.waitForFunction(async()=> (await window.vibeMeet.collaboration.request('status')).value.snapshot.entities.meeting[0].planVersion===2);
    const view=await status(p);assert.match(view.snapshot.entities.meeting[0].plan[0].objective,/新版交付要求/);
    await p.locator('.user-tasks-panel').getByText('升级前计划，未执行；明确说“继续执行”才安排',{exact:true}).waitFor();
    assert.equal(view.snapshot.entities.task.length,0);await noPlanApproval(p);
    assert.deepEqual(await p.evaluate(()=>window.__commands),[]);
  }finally{await p.close();}
});
test('switching meetings preserves their separate plan and dispatched task identities',async()=>{
  const p=await page();try{
    await p.getByRole('button',{name:'夹具：第二会议',exact:true}).click();
    await p.getByRole('button',{name:'夹具：依赖基线',exact:true}).click();await commands(p);
    await p.evaluate(async()=> (await import('/src/lib/unified-meeting-store.ts')).selectSharedMeeting('ui-second-meeting'));
    await p.getByText(/计划 · 1 项 · 已开始 0 项/).waitFor();await noPlanApproval(p);
    await p.evaluate(async()=> (await import('/src/lib/unified-meeting-store.ts')).selectSharedMeeting('ui-unified-meeting'));
    await p.getByText(/计划 · 2 项 · 已开始 1 项/).waitFor();
    assert.equal((await status(p)).snapshot.entities.task[0].id,'task-first');
    assert.deepEqual(await p.evaluate(()=>window.__commands),[]);
  }finally{await p.close();}
});
test('dispatch replaces the planned row with the exact task and does not duplicate it on refresh',async()=>{
  const p=await page();try{
    await commands(p);
    await p.locator('.user-tasks-panel').getByText('升级前计划，未执行；明确说“继续执行”才安排',{exact:true}).waitFor();
    await p.getByRole('button',{name:'夹具：分发首项',exact:true}).click();
    await p.getByText(/计划 · 1 项 · 已开始 1 项/).waitFor();
    await p.getByRole('button',{name:'夹具：相同快照',exact:true}).click();
    assert.equal(await p.locator('.user-tasks-panel tbody tr').count(),1);
    assert.equal((await status(p)).snapshot.entities.task[0].id,'task-whole-api');
    await noPlanApproval(p);assert.deepEqual(await p.evaluate(()=>window.__commands),[]);
  }finally{await p.close();}
});
test('new plan arriving during a send preserves next input and sends no plan decision',async()=>{
  const p=await page();try{
    await commands(p);await delaySends(p);
    await p.locator('textarea').fill('继续执行');
    await p.locator('.drawer-send-icon').click();await p.locator('textarea').fill('下一条补充');
    await p.getByRole('button',{name:'夹具：新计划',exact:true}).click();
    await p.waitForFunction(()=>window.__commands.length===1&&document.querySelector('.drawer-send-icon')?.disabled===false);
    assert.equal(await p.locator('textarea').inputValue(),'下一条补充');
    const sent=await p.evaluate(()=>window.__commands);
    assert.equal(sent[0].action,'message.send');assert.equal(sent[0].payload.text,'继续执行');
    await noPlanApproval(p);
  }finally{await p.close();}
});
