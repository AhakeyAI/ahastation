"""Packaged, local-only Station helper. One JSON request over private stdio.

Never opens a public listener. Native continuation always uses the resident
Desktop gateway; no independent exec/resume fallback is permitted.
"""
from __future__ import annotations
import asyncio
import hashlib
import json
import runpy
import sys
import uuid
from pathlib import Path
from codex_shared import endpoint, scan_async, run_task, launch_desktop
from codex_shared_rpc import RPC
from task_journal import TaskJournal, read_json, write_json
from project_policy import authorized_cwd

def emit(value):
    try: print(json.dumps(value,ensure_ascii=True),flush=True)
    except (OSError,BrokenPipeError): pass

def config_for(grants):
    roots=[g['root'] for g in grants if g.get('confirmed')]
    full=any(g.get('permission')=='full-access' and g.get('fullAccessConfirmed') is True for g in grants)
    writable=any(g.get('permission')=='workspace-write' for g in grants)
    return {'project_policy':{'confirmed':bool(roots),'roots':roots},
        'desktop_permission':'full-access' if full else 'workspace-write' if writable else 'read-only', 'full_access_confirmed':full}

async def execute(request):
    operation=request['operation']; config=config_for(request.get('grants',[]))
    if operation=='self-test': return {'ok':True,'protocol':2,'frozen':bool(getattr(sys,'frozen',False))}
    if operation=='detect':
        installed=False;authenticated=False;linked=False
        try:
            from codex_desktop import discover_runtime
            await asyncio.to_thread(discover_runtime);installed=True
        except Exception:pass
        try:
            shared=endpoint()
            async with RPC(shared['url']) as rpc:
                linked=(await rpc.call('bridge/status',{}))['desktop_connected']
                account=await rpc.call('account/read',{'refreshToken':False},timeout=5)
                authenticated=bool(account.get('account')) or account.get('requiresOpenaiAuth') is False
        except Exception:pass
        return {'installed':installed,'authenticated':authenticated,'linked':linked}
    if operation.startswith('worker-'):
        from station_codex import Guardian,inspect
        if operation in ('worker-run','worker-check'):return await asyncio.to_thread(Guardian(request,emit).run)
        if operation=='worker-inspect':return inspect(request)
        journal=TaskJournal(str(uuid.UUID(request['executionId'])),'codex')
        if operation=='worker-approval':
            identity=str(uuid.UUID(request['approvalId']))
            write_json(journal.path/('approval-'+identity+'.json'),{'decision':request['decision']});return {'ok':True}
        if operation=='worker-stop':
            journal.request_cancel()
            for _ in range(80):
                state=inspect(request)
                if state.get('result'):return state['result']
                await asyncio.sleep(.1)
            return {'cleanup_confirmed':False}
        raise ValueError('Unknown worker operation')
    if operation=='launch':
        from codex_desktop import discover_runtime
        return {'message':await asyncio.to_thread(launch_desktop,discover_runtime())}
    if operation in ('stop','reconcile','grant-slot','run','attach'):
        identity=str(uuid.UUID(request['executionId'])); journal=TaskJournal(identity,'codex')
        # Completed results remain usable even if the resident Desktop is gone.
        if operation in ('reconcile','attach') and journal.result():return journal.result()
        if operation=='stop':
            journal.request_cancel()
            for _ in range(60):
                result=journal.result()
                if result:return result
                await asyncio.sleep(.1)
            return {'cleanup_confirmed':False}
    if operation=='scan':
        continuation=None
        if request.get('paged'):
            from codex_shared import scan_page
            rows,continuation=await scan_page(config,request.get('cursor'))
        else:rows=await scan_async(config)
        selected=[]
        for row in rows:
            try:
                cwd=authorized_cwd(row['cwd'],config['project_policy'])
                grant=next(g for g in request['grants'] if g.get('confirmed') and Path(g['root']).resolve() in [cwd,*cwd.parents])
                # Titles and identity are synchronized; local cwd stays here.
                shared=endpoint()
                async with RPC(shared['url']) as rpc:
                    live=await rpc.call('bridge/status',{'threadId':row['session_id']})
                from codex_shared_service import check_permissions
                try:check_permissions(live.get('configuration',{}),config_for([grant]),cwd)
                except ValueError as error:row.update(available=False,error=str(error))
                permission={'readOnly':'read-only','workspaceWrite':'workspace-write','dangerFullAccess':'full-access'}.get((live.get('configuration',{}).get('sandbox') or {}).get('type'))
                selected.append({**row,'projectId':grant['projectId'],'native_turn_id':live.get('native_turn_id'),'permission':permission or grant['permission']})
            except (ValueError,StopIteration): continue
        return {'sessions':selected,'nextCursor':continuation}
    shared=endpoint()
    async def scoped(rpc,thread):
        metadata=(await rpc.call('thread/read',{'threadId':thread,'includeTurns':False}))['thread']
        cwd=authorized_cwd(metadata['cwd'],config['project_policy'])
        grant=max((g for g in request['grants'] if g.get('confirmed') and Path(g['root']).resolve() in [cwd,*cwd.parents]),key=lambda g:len(Path(g['root']).parts))
        return config_for([grant])
    if operation=='history':
        async with RPC(shared['url']) as rpc:
            row=(await rpc.call('thread/read',{'threadId':request['sessionId'],'includeTurns':False}))['thread']
            authorized_cwd(row['cwd'],config['project_policy'])
            page=await rpc.call('thread/turns/list',{'threadId':request['sessionId'],'limit':10,'itemsView':'full','sortDirection':'asc','cursor':request.get('cursor')})
            messages=[]
            for turn in page.get('data',[]):
                for item in turn.get('items',[]):
                    if item.get('type') not in ('userMessage','agentMessage'): continue
                    text=item.get('text') or '\n'.join(c.get('text','') for c in item.get('content',[]) if isinstance(c,dict))
                    chunks=[text[i:i+3000] for i in range(0,len(text),3000)] or ['']
                    for part,chunk in enumerate(chunks):
                        identity=hashlib.sha256(str(item['id']).encode()).hexdigest()+':'+str(part)
                        messages.append({'id':identity,'source':'station' if turn.get('id') in request.get('stationTurns',[]) else 'desktop',
                            'role':'user' if item['type']=='userMessage' else 'assistant','text':chunk})
            return {'messages':messages,'nextCursor':page.get('nextCursor')}
    if operation=='stop-turn':
        thread=request['sessionId']; turn=request['turnId']
        async with RPC(shared['url']) as rpc:
            return await rpc.call('bridge/native/stop',{'threadId':thread,'turnId':turn,'config':await scoped(rpc,thread)})
    if operation=='approval-list':
        async with RPC(shared['url']) as rpc: return await rpc.call('bridge/approvals',{'threadId':request['sessionId'],'config':await scoped(rpc,request['sessionId'])})
    if operation=='approval-decide':
        async with RPC(shared['url']) as rpc:
            return await rpc.call('bridge/approval/decide',{'approvalId':request['approvalId'],'decision':request['decision'],'config':await scoped(rpc,request['sessionId'])})
    if operation=='grant-slot':
        async with RPC(shared['url']) as rpc:
            known=await rpc.call('bridge/task/state',{'taskId':identity})
            if not known['known'] or known['generation']!=request.get('generation') or known['status']!='waiting-slot':
                raise RuntimeError('原生等待项或连接代次已变化，本次未放行')
        write_json(journal.path/'slot.json',{'granted':True});return {'ok':True}
    if operation=='reconcile':
        from codex_shared import reconcile_task
        async with RPC(shared['url']) as rpc:known=await rpc.call('bridge/task/state',{'taskId':identity})
        if known['known']:return {'cleanup_confirmed':False,'known':True,'status':known['status'],'turnId':known.get('turnId')}
        await reconcile_task(journal);return journal.result() or {'cleanup_confirmed':False}
    if operation not in ('run','attach'): raise ValueError('Unsupported local helper operation')
    async with RPC(shared['url']) as rpc:
        thread=(await rpc.call('thread/read',{'threadId':request['sessionId'],'includeTurns':False}))['thread']
        cwd=authorized_cwd(thread['cwd'],config['project_policy'])
        # Permission belongs to the matching local root, never any other grant.
        grant=next(g for g in request['grants'] if g.get('confirmed') and Path(g['root']).resolve() in [cwd,*cwd.parents])
        config=config_for([grant]);config['station_slot_file']=str(journal.path/'slot.json')
    msg={'task_id':identity,'payload':{'session_id':request['sessionId'],'cwd':str(cwd),'objective':request['objective'],
        'provider':'codex','turn_options':{'mode':'resume','session_id':request['sessionId'],'cwd':str(cwd)}}}
    if operation=='attach':
        async with RPC(shared['url']) as rpc:known=await rpc.call('bridge/task/state',{'taskId':identity})
        if not known['known']:raise RuntimeError('原生接续记录无法核对；不会重新提交')
        saved=journal.payload()
        if not saved or saved['payload']['session_id']!=request['sessionId']:raise RuntimeError('原接续身份不匹配')
    elif not journal.payload(): journal.receive(msg,{'station':True})
    async def state(value): emit({'type':'state','status':value})
    async def observe():
        previous_identity=None
        while not journal.result():
            mapping=read_json(journal.path/'shared.json',{})
            if mapping.get('turn_id') and mapping['turn_id']!=previous_identity:
                previous_identity=mapping['turn_id'];emit({'type':'identity','threadId':request['sessionId'],'turnId':mapping['turn_id']})
            async with RPC(shared['url']) as rpc:
                status=await rpc.call('bridge/status',{'threadId':request['sessionId']})
                if status.get('reservation_owner')=='bridge:'+identity and not status.get('native_turn_id') and status['desktop_connected'] and not (journal.path/'slot.json').exists():
                    emit({'type':'slot-request','executionId':identity,'generation':shared['generation']})
            await asyncio.sleep(.5)
    watcher=asyncio.create_task(observe())
    try:
        if operation=='run':return await run_task(config,msg,state)
        # Reattach only observes the resident task and its durable result. It
        # never invokes bridge/task/submit or turn/start a second time.
        previous=None
        while not journal.result():
            current=read_json(journal.path/'status.json',{}).get('status','waiting')
            if current!=previous:await state(current);previous=current
            async with RPC(shared['url']) as rpc:
                known=await rpc.call('bridge/task/state',{'taskId':identity})
                if not known['known'] and not journal.result():raise RuntimeError('原接续执行状态未确认')
            await asyncio.sleep(.2)
        return journal.result()
    finally: watcher.cancel();await asyncio.gather(watcher,return_exceptions=True)

def main():
    # Node writes UTF-8 even when the Windows console/packaged Python uses a
    # legacy ACP. Reject invalid bytes instead of creating surrogate escapes.
    if hasattr(sys.stdin,'reconfigure'):sys.stdin.reconfigure(encoding='utf-8',errors='strict')
    if '--component' in sys.argv:
        name=sys.argv[sys.argv.index('--component')+1]
        if name not in ('codex_shared_service','task_process','idle_probe','macos_task'): raise ValueError('Unknown component')
        sys.argv=[name]+sys.argv[sys.argv.index('--component')+2:];runpy.run_module(name,run_name='__main__');return
    try:
        request=json.loads(sys.stdin.readline(262145));result=asyncio.run(execute(request));emit({'type':'result','value':result})
    except Exception as error: emit({'type':'error','message':str(error)[:1000]});sys.exit(1)

if __name__=='__main__': main()
