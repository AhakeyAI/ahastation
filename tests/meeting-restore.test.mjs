import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

let nonce = 0;
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function load(path) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text + `\n//fixture-${++nonce}`).toString('base64')}`);
}
const remote = { id: 'saved-remote', remoteTarget: { device_id:'saved-device',agent_id:'saved-agent',provider:'codex',session_id:'native-thread',cwd:'C:\\remote\\project',title:'Saved remote' } };
async function fixture(cwds = ['/saved'], overrides = {}) {
  let listener, serial = 0;
  const calls = { open:[], close:[], forget:[], text:[], add:[] };
  globalThis.window = { setTimeout,clearTimeout,setInterval,clearInterval, vibeMeet: {
    onEvent: fn => { listener = fn; return () => {}; },
    sessions: {
      listRestore: async () => ({ok:true,openTabs:cwds.map(cwd=>({cwd,openedAt:1,remoteHosts:[remote]})),lastActiveCwd:cwds[0]}),
      open: async (...args) => { calls.open.push(args); return {ok:true,sessionId:`real-${++serial}`,cwd:args[0],backendId:'codex',remoteHosts:args[4]}; },
      close: async id => {calls.close.push(id);return {ok:true};},
      forgetRestored: async cwd => {calls.forget.push(cwd);return {ok:true};},
      setActive: async () => ({ok:true}),
      addHost: async (...args) => {calls.add.push(args);return {ok:true,hostId:'new-remote'};},
      ...overrides,
    },
    transcripts: {load:async()=>({ok:true,entries:[]}),append:async()=>({ok:true})},
    sendUserText: async (...args) => {calls.text.push(args);return {ok:true};},
  }};
  const {meetingStore:store} = await load('../src/lib/meeting-store.ts');
  const availability = await load('../src/lib/meeting-availability.ts');
  store.subscribe(()=>{});
  await store.hydrateRestore();
  return {store,calls,availability,event:e=>listener(e),cleanup:()=>{store.dispose();delete globalThis.window;}};
}

test('single restored project exposes continue; no startup/input/placeholder IPC until explicit continuation and real readiness', async()=>{
  const f = await fixture();
  try {
    const ph = f.store.getTabs()[0];
    assert.equal(ph.phase,'restored'); assert.equal(f.store.getSnapshot().running,false); assert.equal(f.calls.open.length,0);
    assert.deepEqual(f.store.getSnapshot().hostGroups.get(remote.id).remoteTarget,remote.remoteTarget);
    const {MeetingResumeBanner} = await load('../src/components/MeetingResumeBanner.tsx');
    const html = renderToStaticMarkup(createElement(MeetingResumeBanner,{tab:ph,error:null,onContinue:()=>f.store.continueMeeting(ph.id),onHome:()=>{}}));
    assert.match(html,/继续会议/); assert.match(html,/会议未启动/); assert.doesNotMatch(html,/Ready|已加入/);
    assert.equal(f.availability.meetingAvailability(ph,false).sessionId,null);
    await f.store.sendText('must not execute');
    assert.equal((await f.store.addHostGroup('pocket-vibe',remote.remoteTarget)).ok,false);
    assert.deepEqual(f.calls.text,[]); assert.deepEqual(f.calls.add,[]);
    await f.store.continueMeeting(ph.id);
    assert.deepEqual(f.calls.open[0],['/saved','',undefined,undefined,[remote]]);
    assert.equal(f.store.getTabs()[0].phase,'starting');
    assert.equal(f.availability.meetingAvailability(f.store.getTabs()[0],true).ready,false);
    f.event({sessionId:'real-1',source:'system',kind:'session-ready',hostId:'default'});
    const gate=f.availability.meetingAvailability(f.store.getTabs()[0],f.store.getSnapshot().running);
    assert.equal(gate.ready,true); assert.equal(f.availability.remotePickerReason(true,gate.reason,gate.sessionId),'');
    await f.store.sendText('ordinary chat'); await f.store.addHostGroup('pocket-vibe',remote.remoteTarget);
    assert.deepEqual(f.calls.text,[['real-1','ordinary chat']]); assert.equal(f.calls.add[0][0],'real-1');
  } finally {f.cleanup();}
});

test('duplicate continue shares one open; IPC and transport failures are visible and retry retains native references',async()=>{
  const waiting=deferred(); let count=0;
  const f=await fixture(['/saved'],{open:async(...args)=>{count++; if(count===1)return waiting.promise;return {ok:true,sessionId:`retry-${count}`,cwd:args[0],remoteHosts:args[4]};}});
  try {
    const id=f.store.getActiveId(); const a=f.store.continueMeeting(id),b=f.store.continueMeeting(id);
    await tick(); assert.equal(count,1); assert.equal(f.store.getTabs()[0].phase,'starting');
    waiting.reject(new Error('actual transport failure')); await Promise.all([a,b]);
    assert.equal(f.store.getTabs()[0].phase,'failed'); assert.match(f.store.getSnapshot().lastError,/actual transport failure/);
    await f.store.continueMeeting(id); f.event({sessionId:'retry-2',source:'system',kind:'session-start-failed',error:'native startup failure'});
    assert.equal(f.store.getTabs()[0].phase,'failed');
    const retry1=f.store.continueMeeting('retry-2'),retry2=f.store.continueMeeting('retry-2'); await Promise.all([retry1,retry2]);
    assert.equal(count,3); assert.deepEqual(f.store.getSnapshot().hostGroups.get(remote.id).remoteTarget,remote.remoteTarget);
    f.event({sessionId:'retry-2',source:'system',kind:'session-ready'}); assert.equal(f.store.getTabs()[0].phase,'starting');
    f.event({sessionId:'retry-3',source:'system',kind:'session-ready'}); assert.equal(f.store.getTabs()[0].phase,'ready');
  } finally {f.cleanup();}
});

test('multi-project resume preserves focus/references; close during open retires returned meeting and late events',async()=>{
  const waiting=deferred();
  const f=await fixture(['/a','/b'],{open:async(cwd)=>waiting.promise});
  try {
    const [a,b]=f.store.getTabs(); const pending=f.store.continueMeeting(a.id); await tick();
    await f.store.setActive(b.id); await f.store.closeTab(a.id);
    assert.deepEqual(f.calls.forget,['/a']);
    waiting.resolve({ok:true,sessionId:'late-a',cwd:'/a'}); assert.equal((await pending).ok,false);
    f.event({sessionId:'late-a',source:'system',kind:'session-ready'});
    assert.equal(f.store.getTabs().length,1); assert.equal(f.store.getActiveId(),b.id); assert.deepEqual(f.calls.close,['late-a']);
    assert.deepEqual(f.store.getSnapshot().hostGroups.get(remote.id).remoteTarget,remote.remoteTarget);
    await f.store.closeTab(b.id); await f.store.hydrateRestore(); assert.deepEqual(f.store.getTabs(),[]);
  } finally {f.cleanup();}
});

test('early ready before open reply is replayed; auxiliary host ready/failure cannot change primary meeting phase',async()=>{
  let emit;
  const f=await fixture(['/saved'],{open:async(cwd)=>{emit({sessionId:'early',source:'system',hostId:'aux',kind:'session-ready'});emit({sessionId:'early',source:'system',kind:'session-ready'});return {ok:true,sessionId:'early',cwd};}});
  emit=f.event;
  try {
    await f.store.continueMeeting(f.store.getActiveId()); assert.equal(f.store.getTabs()[0].phase,'ready');
    assert.equal(f.store.getSnapshot().workers.get('talker:aux').status,'running');
    f.event({sessionId:'early',source:'system',kind:'session-start-failed',hostId:'aux',error:'aux unavailable'});
    assert.equal(f.store.getSnapshot().running,true); assert.equal(f.store.getTabs()[0].phase,'ready');
  } finally {f.cleanup();}
});

test('renderer reload attaches to existing real meeting instead of dropping placeholder into nonexistent slot',async()=>{
  const f=await fixture(['/saved'],{open:async()=>({ok:false,error:'duplicate',sessionId:'existing',cwd:'/saved'}),listHosts:async()=>({ok:true,hosts:[{id:'default',backendId:'codex',ready:true},{...remote,backendId:'pocket-vibe',ready:true}]})});
  try {
    await f.store.continueMeeting(f.store.getActiveId()); assert.equal(f.store.getActiveId(),'existing');
    assert.equal(f.store.getTabs()[0].phase,'ready'); assert.equal(f.store.getSnapshot().hostGroups.get(remote.id).remoteReady,true);
    await f.store.sendText('@saved-remote continue'); assert.equal(f.calls.text[0][0],'existing');
  } finally {f.cleanup();}
});

test('reload attaches an ended existing meeting as ended; continuation retries the same project and remote references',async()=>{
  let opens=0;
  const f=await fixture(['/saved'],{
    open:async(...args)=>{
      f.calls.open.push(args);
      return ++opens===1
        ? {ok:false,error:'duplicate',sessionId:'ended-existing',cwd:args[0]}
        : {ok:true,sessionId:'restarted',cwd:args[0],backendId:'codex',remoteHosts:args[4]};
    },
    listHosts:async()=>({ok:true,hosts:[{id:'default',backendId:'codex',ready:false,phase:'ended'},{...remote,backendId:'pocket-vibe',ready:false,phase:'ended'}]}),
  });
  try {
    await f.store.continueMeeting(f.store.getActiveId());
    assert.equal(f.store.getTabs()[0].phase,'ended');
    assert.equal(f.store.getSnapshot().running,false);
    const {MeetingResumeBanner}=await load('../src/components/MeetingResumeBanner.tsx');
    const html=renderToStaticMarkup(createElement(MeetingResumeBanner,{tab:f.store.getTabs()[0],error:null,onContinue:()=>{},onHome:()=>{}}));
    assert.doesNotMatch(html,/disabled=/);
    assert.equal(f.availability.meetingAvailability(f.store.getTabs()[0],false).ready,false);
    assert.deepEqual(f.calls.text,[]);
    await f.store.continueMeeting('ended-existing');
    assert.deepEqual(f.calls.close,['ended-existing']);
    assert.deepEqual(f.calls.open[1],['/saved','', 'codex',undefined,[remote]]);
    f.event({sessionId:'restarted',source:'system',kind:'session-ready'});
    assert.equal(f.store.getTabs()[0].phase,'ready');
  } finally {f.cleanup();}
});

test('reload distinguishes an existing pending handshake from a failed host and keeps real readiness gated',async()=>{
  for (const phase of ['starting','failed']) {
    const f=await fixture(['/saved'],{
      open:async()=>({ok:false,error:'duplicate',sessionId:'existing',cwd:'/saved'}),
      listHosts:async()=>({ok:true,hosts:[{id:'default',backendId:'codex',ready:false,phase,error:phase==='failed'?'login expired':undefined}]}),
    });
    try {
      await f.store.continueMeeting(f.store.getActiveId());
      assert.equal(f.store.getTabs()[0].phase,phase);
      assert.equal(f.availability.meetingAvailability(f.store.getTabs()[0],false).ready,false);
      if (phase==='failed') assert.equal(f.store.getSnapshot().lastError,'login expired');
      else {
        f.event({sessionId:'existing',source:'system',kind:'session-ready'});
        assert.equal(f.store.getTabs()[0].phase,'ready');
      }
    } finally {f.cleanup();}
  }
});

test('duplicate attachment restores both local terminal participants and saved remote targets',async()=>{
  const f=await fixture(['/saved'],{
    open:async()=>({ok:false,error:'duplicate',sessionId:'existing',cwd:'/saved'}),
    listHosts:async()=>({ok:true,hosts:[
      {id:'default',backendId:'codex',ready:false,phase:'ended'},
      {id:'local-terminal',backendId:'codex-terminal',ready:true,phase:'ready'},
      {...remote,backendId:'pocket-vibe',ready:true,phase:'ready'},
    ]}),
  });
  try {
    await f.store.continueMeeting(f.store.getActiveId());
    assert.equal(f.store.getTabs()[0].phase,'ended');
    assert.equal(f.store.getSnapshot().running,false);
    assert.equal(f.store.getSnapshot().hostGroups.get('local-terminal').backendId,'codex-terminal');
    assert.deepEqual(f.store.getSnapshot().hostGroups.get(remote.id).remoteTarget,remote.remoteTarget);
    assert.equal(f.store.getSnapshot().hostGroups.get(remote.id).remoteReady,true);
    assert.deepEqual(f.calls.text,[]);
  } finally {f.cleanup();}
});

test('existing host snapshot supersedes earlier readiness; terminal events during the query remain retryable',async()=>{
  for (const endedAt of ['before-query','during-query']) {
    const waiting=deferred();
    const f=await fixture(['/saved'],{
      open:async()=>{
        f.event({sessionId:'existing',source:'system',kind:'session-ready'});
        return {ok:false,error:'duplicate',sessionId:'existing',cwd:'/saved'};
      },
      listHosts:async()=>{
        if(endedAt==='during-query')await waiting.promise;
        return {ok:true,hosts:[{id:'default',backendId:'codex',ready:endedAt==='during-query',phase:endedAt==='during-query'?'ready':'ended'}]};
      },
    });
    try {
      const pending=f.store.continueMeeting(f.store.getActiveId());await tick();
      if(endedAt==='during-query')f.event({sessionId:'existing',source:'talker',hostId:'default',kind:'ended'});
      waiting.resolve();await pending;
      assert.equal(f.store.getTabs()[0].phase,'ended');
      assert.equal(f.store.getSnapshot().running,false);
      assert.deepEqual(f.calls.text,[]);
    } finally {waiting.resolve();f.cleanup();}
  }
});

test('late duplicate open or host listing restores the selected real meeting in both renderer and main',async()=>{
  for (const delayedAt of ['open','listHosts']) {
    const waiting=deferred(); let mainActive=null, startedListing=false;
    const f=await fixture(['/a','/b'],{
      open:async cwd=>{
        if(cwd==='/b'){mainActive='real-b';return {ok:true,sessionId:'real-b',cwd,backendId:'codex'};}
        if(delayedAt==='open')await waiting.promise;
        mainActive='existing-a';return {ok:false,error:'duplicate',sessionId:'existing-a',cwd};
      },
      listHosts:async()=>{
        startedListing=true;
        if(delayedAt==='listHosts')await waiting.promise;
        return {ok:true,hosts:[{id:'default',backendId:'codex',ready:true,phase:'ready'}]};
      },
      setActive:async id=>{mainActive=id;return {ok:true};},
    });
    try {
      const [a,b]=f.store.getTabs();
      await f.store.setActive(b.id);await f.store.continueMeeting(b.id);
      f.event({sessionId:'real-b',source:'system',kind:'session-ready'});
      await f.store.setActive(a.id);
      const pending=f.store.continueMeeting(a.id);await tick();
      assert.equal(startedListing,delayedAt==='listHosts');
      await f.store.setActive('real-b');waiting.resolve();await pending;
      assert.equal(f.store.getActiveId(),'real-b');
      assert.equal(mainActive,'real-b');
      await f.store.sendText('B only');assert.deepEqual(f.calls.text.at(-1),['real-b','B only']);
      assert.equal(f.store.getTabs().find(tab=>tab.id==='existing-a').phase,'ready');
    } finally {f.cleanup();}
  }
});

test('choosing existing folder before restore hydration attaches to real meeting with one open and no new model startup',async()=>{
  const f=await fixture([], {open:async cwd=>{f.calls.open.push(cwd);return {ok:false,error:'duplicate',sessionId:'existing-main',cwd};},listHosts:async()=>({ok:true,hosts:[{id:'default',backendId:'codex',ready:true}]})});
  try {
    assert.equal((await f.store.openSession('/already-running')).ok,true);
    assert.equal(f.store.getTabs()[0].phase,'ready');assert.equal(f.store.getActiveId(),'existing-main');assert.equal(f.calls.open.length,1);
    await f.store.sendText('continue');assert.equal(f.calls.text[0][0],'existing-main');
  } finally {f.cleanup();}
});

test('remote setting change refreshes production backend observer without focus; stale result/unmount does not overwrite current state',async()=>{
  const a=deferred(),b=deferred(), rows=[], errors=[]; let changed, focus, reads=0, unsubscribed=false;
  globalThis.window={vibeMeet:{backendAuth:{list:()=>++reads===1?a.promise:b.promise},remoteControl:{onChanged:fn=>{changed=fn;return()=>{unsubscribed=true};}}},addEventListener:(_,fn)=>{focus=fn;},removeEventListener:()=>{}};
  const {watchBackendList}=await load('../src/lib/backend-refresh.ts');
  const stop=watchBackendList(value=>rows.push(value),value=>errors.push(value));
  try {
    changed(); focus(); a.resolve([{id:'pocket-vibe',loggedIn:false}]); await tick();
    assert.equal(reads,2); assert.deepEqual(rows,[]);
    b.resolve([{id:'pocket-vibe',loggedIn:true}]); await tick(); assert.equal(rows[0][0].loggedIn,true);
    stop(); assert.equal(unsubscribed,true); changed(); assert.equal(reads,2); assert.deepEqual(errors,[]);
  } finally {stop();delete globalThis.window;}
});

test('two restored projects start concurrently without stealing focus or cross-routing members/replies',async()=>{
  const one=deferred(),two=deferred();
  const remoteB={id:'saved-b',remoteTarget:{...remote.remoteTarget,session_id:'native-b',cwd:'/remote/b',title:'B'}};
  const f=await fixture(['/a','/b'],{
    listRestore:async()=>({ok:true,openTabs:[{cwd:'/a',openedAt:1,remoteHosts:[remote]},{cwd:'/b',openedAt:2,remoteHosts:[remoteB]}],lastActiveCwd:'/a'}),
    open:async cwd=>cwd==='/a'?one.promise:two.promise,
  });
  try {
    const [a,b]=f.store.getTabs();const pa=f.store.continueMeeting(a.id);await f.store.setActive(b.id);const pb=f.store.continueMeeting(b.id);
    two.resolve({ok:true,sessionId:'b',cwd:'/b',backendId:'codex',remoteHosts:[remoteB]});await pb;
    one.resolve({ok:true,sessionId:'a',cwd:'/a',backendId:'codex',remoteHosts:[remote]});await pa;
    assert.equal(f.store.getActiveId(),'b');
    f.event({sessionId:'a',source:'system',kind:'session-ready'});f.event({sessionId:'b',source:'system',kind:'session-ready'});
    f.event({sessionId:'a',source:'talker',hostId:remote.id,kind:'message',message:{type:'assistant',message:{content:[{type:'text',text:'A response'}]}}});
    assert.equal(f.store.getSnapshot().hostGroups.has(remote.id),false);assert.equal(f.store.getSnapshot().hostGroups.get(remoteB.id).remoteTarget.session_id,'native-b');
    await f.store.sendText('B command');assert.deepEqual(f.calls.text.at(-1),['b','B command']);
    await f.store.setActive('a');assert.equal(f.store.getSnapshot().workers.get('talker:'+remote.id).lastText,'A response');
    f.store.syncDefaultBackend('claude-code');assert.equal(f.store.getSnapshot().hostGroups.get('default').backendId,'codex');
    await f.store.closeTab('a');assert.equal(f.store.getActiveId(),'b');assert.equal(f.store.getTabs().length,1);
  } finally {f.cleanup();}
});

test('late tab activation cannot override a newer selection or revive a closed project',async()=>{
  const wait=deferred();let delayed=false;
  const f=await fixture(['/a','/b'],{setActive:async id=>delayed&&id==='real-1'?wait.promise:{ok:true}});
  try {
    const [a,b]=f.store.getTabs();await f.store.continueMeeting(a.id);await f.store.setActive(b.id);await f.store.continueMeeting(b.id);
    delayed=true;const old=f.store.setActive('real-1');await tick();await f.store.setActive('real-2');
    wait.resolve({ok:true});await old;assert.equal(f.store.getActiveId(),'real-2');
    await f.store.closeTab('real-1');f.event({sessionId:'real-1',source:'system',kind:'session-ready'});assert.equal(f.store.getActiveId(),'real-2');
  } finally {f.cleanup();}
});

test('home navigation supersedes delayed hydration; Leave on reload closes the actual registry ID, never a placeholder',async()=>{
  const waiting=deferred();
  const f=await fixture([]);
  try {
    f.store.restoreHydrated=false;
    window.vibeMeet.sessions.listRestore=()=>waiting.promise;
    const pending=f.store.hydrateRestore();f.store.dismissRestoreHydration();
    waiting.resolve({ok:true,openTabs:[{cwd:'/late',openedAt:1}],lastActiveCwd:'/late'});await pending;
    assert.deepEqual(f.store.getTabs(),[]);
  } finally {f.cleanup();}
  const reloaded=await fixture(['/reloaded'],{forgetRestored:async()=>({ok:false,error:'already open',sessionId:'actual-real'})});
  try {await reloaded.store.closeTab(reloaded.store.getActiveId());assert.deepEqual(reloaded.calls.close,['actual-real']);assert.deepEqual(reloaded.store.getTabs(),[]);}
  finally {reloaded.cleanup();}
});

test('backend preferences cannot relabel an existing Codex meeting; failed remote host still does not send input locally',async()=>{
  const f=await fixture();
  try {
    await f.store.continueMeeting(f.store.getActiveId());f.event({sessionId:'real-1',source:'system',kind:'session-ready'});
    f.store.syncDefaultBackend('claude-code');assert.equal(f.store.getSnapshot().hostGroups.get('default').backendId,'codex');
    assert.match(f.availability.remotePickerReason(false,'', 'real-1'),/登录/);
    f.event({sessionId:'real-1',source:'system',kind:'session-start-failed',hostId:remote.id,remoteTarget:remote.remoteTarget,error:'offline'});
    await f.store.sendText('@saved-remote must stay remote');assert.deepEqual(f.calls.text,[]);assert.equal(f.store.getSnapshot().running,true);
  } finally {f.cleanup();}
});
