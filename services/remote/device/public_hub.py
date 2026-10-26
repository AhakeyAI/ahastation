"""Opt-in multi-owner HTTPS/WSS Hub. The legacy LAN app remains separate.

Deploy exactly one process/instance: DB durability is not distributed routing.
Only this app is exposed by the public Dockerfile; no legacy debug/GUI routes.
"""
from __future__ import annotations
import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError
import device_hub as catalog
from hub_store import HubStore, FINAL
from protocol import envelope, now_iso

PROTOCOL=2
BODY_LIMIT=64*1024
MESSAGE_LIMIT=128*1024
log=logging.getLogger('ahastation.hub')

def bearer(headers):
    value=headers.get('authorization','')
    return value[7:] if value.startswith('Bearer ') else ''

async def deny_socket(ws,status,detail):
    if 'websocket.http.response' in ws.scope.get('extensions',{}):
        headers={'X-AhaStation-Auth-Error':'invalid-credential'} if status in {401,403} else {}
        return await ws.send_denial_response(JSONResponse({'detail':detail},status,headers=headers))
    await ws.accept()
    await ws.close(code=4401 if status in {401,403} else 4406 if status==400 else 1013,reason=detail)

class Limits:
    def __init__(self,app): self.app=app; self.active=0; self.sockets=0
    async def __call__(self,scope,receive,send):
        if scope['type']=='websocket':
            if self.sockets>=1000:
                if 'websocket.http.response' in scope.get('extensions',{}):
                    await send({'type':'websocket.http.response.start','status':429,'headers':[]})
                    return await send({'type':'websocket.http.response.body','body':b'Connection limit reached'})
                await send({'type':'websocket.accept'})
                return await send({'type':'websocket.close','code':1013})
            self.sockets+=1
            try: return await self.app(scope,receive,send)
            finally: self.sockets-=1
        if scope['type']!='http': return await self.app(scope,receive,send)
        if self.active>=128: return await JSONResponse({'detail':'Server busy'},429)(scope,receive,send)
        events=[]; size=0; status_code=0; raw_send=send
        async def tracked_send(event):
            nonlocal status_code
            if event['type']=='http.response.start': status_code=event['status']
            await raw_send(event)
        send=tracked_send
        self.active+=1
        started=time.monotonic()
        try:
            while True:
                try: event=await asyncio.wait_for(receive(),timeout=max(.01,10-(time.monotonic()-started)))
                except asyncio.TimeoutError: return await JSONResponse({'detail':'Request read timed out'},408)(scope,receive,send)
                if event['type']=='http.disconnect': return
                size+=len(event.get('body',b''))
                if size>BODY_LIMIT: return await JSONResponse({'detail':'Request is too large'},413)(scope,receive,send)
                events.append(event)
                if len(events)>1024: return await JSONResponse({'detail':'Too many request chunks'},413)(scope,receive,send)
                if not event.get('more_body'): break
            async def bounded_receive():
                return events.pop(0) if events else await receive()
            await self.app(scope,bounded_receive,send)
        finally:
            self.active-=1
            # No URL/query, headers, usernames, prompts or exception secrets.
            log.info('http method=%s status=%d duration_ms=%d active_http=%d',scope['method'],status_code,int((time.monotonic()-started)*1000),self.active)

class PublicAgent(catalog.DesktopAgent):
    async def send(self,msg_type,payload,task_id=None):
        self.seq+=1
        msg=envelope(msg_type,payload,task_id=task_id,seq=self.seq)
        await self.websocket.send_json(msg)
        return msg

def create_app(store=None):
    if os.getenv('WEB_CONCURRENCY','1')!='1': raise RuntimeError('Public Hub requires one worker and one instance')
    connections={}  # agent -> (owner, device credential digest, agent); no authorization from client claims.
    pump_lock=asyncio.Lock()
    database=store

    async def db(method,*args,**kwargs):
        try: return await asyncio.to_thread(getattr(database,method),*args,**kwargs)
        except SQLAlchemyError:
            log.error('database unavailable')
            raise HTTPException(503,'Hub database is unavailable; operation was not confirmed')

    async def principal(request,scope='control'):
        return await db('authenticate',bearer(request.headers),scope)

    async def pump(owner):
        async with pump_lock:
            pending=await db('list_tasks',owner,active=True)
            for task in reversed(pending):
                if task['status']!='queued': continue
                entry=connections.get(task['target_agent'])
                if not entry or entry[0]!=owner:
                    await db('transition',owner,task['task_id'],'failed',error='Selected Bridge disconnected before delivery; task was not executed',result={'ok':False,'cleanup_confirmed':True})
                    continue
                agent=entry[2]
                try: catalog.validate_remote_target(task['remote_target'])
                except HTTPException as exc:
                    await db('transition',owner,task['task_id'],'failed',error=str(exc.detail),result={'ok':False,'cleanup_confirmed':True})
                    continue
                if not await db('admit_dispatch',owner,task['task_id']): continue
                try:
                    await agent.send('task',{key:task[key] for key in ('objective','provider','session_id','cwd','turn_options','remote_target')},task_id=task['task_id'])
                    await db('transition',owner,task['task_id'],'delivered')
                except Exception:
                    await db('transition',owner,task['task_id'],'delivery-uncertain',error='Delivery is uncertain; reconcile or cancel before retrying')
                latest=await db('get_task',owner,task['task_id'])
                if latest['status'] not in FINAL and latest.get('cancel_requested'):
                    try: await agent.send('cancel',{},task_id=task['task_id'])
                    except Exception: pass  # Persisted request also reconciles after reconnect.

    async def upkeep():
        while True:
            await asyncio.sleep(300)
            try: await db('cleanup',int(os.getenv('HUB_FEEDBACK_DAYS','7')))
            except HTTPException: pass
            log.info('hub connected_bridges=%d',len(connections))  # CPU/RAM/DB utilization is monitored by the host platform.

    @asynccontextmanager
    async def lifespan(app):
        nonlocal database
        database=database or HubStore.production()
        await db('ready')  # Fail startup; never serve public mode without its DB.
        cleanup=asyncio.create_task(upkeep())
        yield
        cleanup.cancel()
        for _,_,agent in list(connections.values()):
            await agent.websocket.close(code=1012,reason='Hub maintenance; reconnect and reconcile')
        await asyncio.gather(cleanup,return_exceptions=True)

    app=FastAPI(title='AhaStation public Hub',lifespan=lifespan,docs_url=None,redoc_url=None,openapi_url=None)
    app.add_middleware(Limits)
    app.state.connections=connections
    app.state.store=lambda:database
    from collaboration_routes import install
    install(app,db,principal)

    @app.exception_handler(SQLAlchemyError)
    async def unavailable(_,exc): return JSONResponse({'detail':'Hub database is unavailable'},503)

    @app.get('/health')
    async def health(): return {'ok':True,'protocol':PROTOCOL,'service':'ahastation-hub'}

    @app.get('/ready')
    async def ready(): await db('ready'); return {'ok':True,'protocol':PROTOCOL}

    @app.post('/v2/auth/{action}')
    async def auth(action:str,payload:dict,request:Request):
        if action not in {'register','login','recover'}: raise HTTPException(404,'Not found')
        login=payload.get('login',''); password=payload.get('password',''); recovery=payload.get('recovery_code','')
        if not all(isinstance(value,str) for value in (login,password,recovery)): raise HTTPException(400,'Invalid account input')
        if action=='recover' and not 20<=len(recovery)<=80: raise HTTPException(400,'A saved recovery code is required')
        await db('rate','auth-ip:'+request.client.host,15)
        await db('rate','auth-account:'+login.lower(),6)
        return await db('identity',login,password,register=action=='register',recovery=recovery if action=='recover' else '')

    @app.get('/v2/me')
    async def me(request:Request):
        user=await principal(request)
        return {'ok':True,'owner_id':user['owner'],'protocol':PROTOCOL}

    @app.get('/v2/version')
    async def version():
        return {'ok':True,'protocol':PROTOCOL,'bridge_version':'0.2.0','download_url':os.getenv('BRIDGE_DOWNLOAD_URL','')}

    @app.post('/v2/logout')
    async def logout(payload:dict,request:Request):
        user=await principal(request)
        await db('revoke',user['owner'],token=None if payload.get('all') is True else bearer(request.headers))
        return {'ok':True}

    @app.post('/v2/pairings')
    async def pairing(request:Request):
        user=await principal(request); await db('rate','pair:'+user['owner'],6)
        return await db('create_pair',user['owner'])

    @app.post('/v2/pairings/claim')
    async def claim(payload:dict,request:Request):
        await db('rate','claim:'+request.client.host,12)
        if payload.get('projects_confirmed') is not True: raise HTTPException(400,'Confirm project authorization on the remote computer first')
        code=payload.get('pair_code','')
        if not isinstance(code,str) or not 20<=len(code)<=80: raise HTTPException(400,'Invalid pairing code')
        return await db('claim_pair',code,payload.get('device_id',''),payload.get('name',''))

    @app.get('/v2/devices')
    async def list_devices(request:Request):
        user=await principal(request); rows=await db('list_devices',user['owner'])
        for row in rows:
            row['online']=any(owner==user['owner'] and agent.device_id==row['id'] for owner,_,agent in connections.values())
            row['agents']=[agent.snapshot() for owner,_,agent in connections.values() if owner==user['owner'] and agent.device_id==row['id']]
        return {'ok':True,'devices':rows,'protocol':PROTOCOL}

    @app.delete('/v2/devices/{device}')
    async def unpair(device:str,request:Request):
        user=await principal(request); await db('owned_device',user['owner'],device)
        await db('drain_device',user['owner'],device)  # Reject new work while allowing already-connected cleanup acknowledgements.
        for task in await db('list_tasks',user['owner'],device,active=True):
            await cancel(task['task_id'],request)
        for owner,_,agent in list(connections.values()):
            if owner==user['owner'] and agent.device_id==device:
                for task in await db('list_tasks',owner,device,active=True):
                    try: await agent.send('cancel',{},task_id=task['task_id'])
                    except Exception: pass
        deadline=time.monotonic()+8
        while time.monotonic()<deadline and await db('list_tasks',user['owner'],device,active=True): await asyncio.sleep(.1)
        confirmed=not await db('list_tasks',user['owner'],device,active=True)
        await db('revoke',user['owner'],device=device)
        for owner,_,agent in list(connections.values()):
            if owner==user['owner'] and agent.device_id==device: await agent.websocket.close(code=4401,reason='Device unpaired')
        return {'ok':True,'cleanup_confirmed':confirmed}

    @app.post('/v2/device/unpair')
    async def local_unpair(request:Request):
        user=await principal(request,'device'); await db('revoke',user['owner'],device=user['device'])
        for owner,_,agent in list(connections.values()):
            if owner==user['owner'] and agent.device_id==user['device']: await agent.websocket.close(code=4401,reason='Device unpaired')
        return {'ok':True}

    @app.get('/v1/remote-sessions')
    async def remote_sessions(request:Request,refresh:bool=False):
        user=await principal(request); await db('rate','catalog:'+user['owner'],120)
        connected=[agent for owner,_,agent in connections.values() if owner==user['owner']]
        directory=await catalog.remote_directory(connected,refresh)
        pending=await db('list_tasks',user['owner'],active=True)
        revisions={row['agent_id']:row['revision'] for row in directory['agents']}
        for row in directory['sessions']:
            live=row.get('execution_status','unknown'); states=set()
            for task in pending:
                target=task.get('remote_target',{})
                if any(target.get(key)!=row.get(key) for key in ('device_id','provider','session_id')): continue
                entry=connections.get(task['target_agent'])
                if not entry: continue
                same=task.get('execution_connection')==entry[2].connection_id
                state=task.get('execution_status','waiting')
                if state=='cleanup-unconfirmed' and live!='unknown' and (not same or revisions.get(row['agent_id'],0)>task.get('execution_revision',0)): continue
                if same or task['status']=='queued': states.add(state)
            for state in ('cleanup-unconfirmed','running','waiting'):
                if state==live or state in states: row['execution_status']=state; break
        return directory

    @app.get('/v1/agents')
    async def list_agents(request:Request):
        user=await principal(request)
        return {'ok':True,'agents':[agent.snapshot() for owner,_,agent in connections.values() if owner==user['owner']]}

    @app.post('/v1/turns')
    async def submit(payload:dict,request:Request):
        user=await principal(request); await db('rate','task:'+user['owner'],30)
        if os.getenv('HUB_MAINTENANCE')=='1': raise HTTPException(503,'Hub is in maintenance; new tasks are paused')
        if any(payload.get(key) for key in ('attachments','images','image','files')): raise HTTPException(400,'Remote execution supports text only; remove attachments')
        target=payload.get('remote_target')
        if not isinstance(target,dict): raise HTTPException(400,'Public mode requires an explicitly selected native session')
        if not all(isinstance(target.get(key),str) and target[key] for key in ('device_id','agent_id','provider','session_id','cwd')): raise HTTPException(400,'Incomplete remote session reference')
        options=payload.get('turn_options',{})
        if not isinstance(options,dict) or set(options)-{'mode','cwd','session_id'}: raise HTTPException(400,'Execution permissions and model configuration belong to the remote computer')
        if (payload.get('provider')!=target['provider'] or payload.get('session_id')!=target['session_id']
            or payload.get('cwd')!=target['cwd'] or payload.get('target_agent_id')!=target['agent_id']
            or options.get('mode','resume')!='resume' or options.get('session_id',target['session_id'])!=target['session_id']
            or options.get('cwd',target['cwd'])!=target['cwd']): raise HTTPException(400,'Remote reference does not match execution parameters')
        objective=payload.get('prompt') or payload.get('objective','')
        if not isinstance(objective,str) or not objective.strip() or len(objective)>16000: raise HTTPException(400,'Text prompt must contain 1–16000 characters')
        clean={'objective':objective,'provider':target['provider'],'session_id':target['session_id'],'cwd':target['cwd'],
            'turn_options':options,'remote_target':{key:target[key] for key in ('agent_id','device_id','provider','session_id','cwd')}}
        existing=await db('existing_submission',user['owner'],payload.get('idempotency_key'),clean)
        if existing: return {'ok':True,'turn_id':existing['task_id'],'task':existing}
        await db('owned_device',user['owner'],target['device_id'])
        entry=connections.get(target['agent_id'])
        if not entry or entry[0]!=user['owner']: raise HTTPException(409,'Selected device or Agent is offline; task was not queued')
        agent=entry[2]; snap=await catalog.refresh_remote_catalog(agent)
        if connections.get(agent.agent_id)!=entry: raise HTTPException(409,'Bridge disconnected during validation')
        catalog.validate_remote_target(target,snap)
        task,new=await db('submit',user['owner'],target['device_id'],agent.agent_id,payload.get('idempotency_key'),clean)
        if new: await pump(user['owner'])
        task=await db('get_task',user['owner'],task['task_id'])
        return {'ok':True,'turn_id':task['task_id'],'task':task}

    @app.get('/v1/turns/{task_id}')
    async def get_turn(task_id:str,request:Request):
        user=await principal(request); return {'ok':True,'turn_id':task_id,'task':await db('get_task',user['owner'],task_id)}

    @app.get('/v2/tasks')
    async def list_turns(request:Request):
        user=await principal(request); rows=await db('list_tasks',user['owner'])
        return {'ok':True,'tasks':[{key:task[key] for key in ('task_id','status','target_agent','session_id','error') if key in task} for task in rows]}

    @app.get('/v2/submissions/{key}')
    async def submission(key:str,request:Request):
        user=await principal(request); task=await db('by_key',user['owner'],key)
        return {'ok':True,'turn_id':task['task_id'],'task':task}

    @app.post('/v2/submissions/{key}/cancel')
    async def cancel_submission(key:str,request:Request):
        user=await principal(request); await db('rate','cancel:'+user['owner'],60)
        task_id=await db('cancel_key',user['owner'],key)
        return await cancel(task_id,request)

    @app.post('/v1/turns/{task_id}/cancel')
    async def cancel(task_id:str,request:Request):
        user=await principal(request); await db('rate','cancel:'+user['owner'],60)
        task=await db('request_cancel',user['owner'],task_id)
        if task['status'] not in FINAL:
            entry=connections.get(task['target_agent'])
            if entry and entry[0]==user['owner']:
                try: await entry[2].send('cancel',{},task_id=task_id)
                except Exception: pass  # Durable request is delivered on reconnect.
        await pump(user['owner'])
        return {'ok':True,'turn_id':task_id,'task':task}

    @app.websocket('/ws/desktop')
    async def desktop(ws:WebSocket,provider:str=''):
        if provider not in {'codex','claude'}: return await deny_socket(ws,400,'Unsupported provider')
        if len(connections)>=1000: return await deny_socket(ws,429,'Connection limit reached')
        try: user=await db('authenticate',bearer(ws.headers),'device')
        except HTTPException as exc: return await deny_socket(ws,exc.status_code,'Database temporarily unavailable' if exc.status_code==503 else 'Device credential invalid')
        try: await db('owned_device',user['owner'],user['device'])
        except HTTPException as exc: return await deny_socket(ws,503 if exc.status_code==503 else 403,'Database temporarily unavailable' if exc.status_code==503 else 'Device is being unpaired')
        assigned=f"{user['device']}-{provider}"
        if assigned in connections: return await deny_socket(ws,409,'Device provider already connected')
        agent=PublicAgent(assigned,ws,device_id=user['device'])
        entry=(user['owner'],user['digest'],agent)
        connections[assigned]=entry; catalog.agents[assigned]=agent
        try: await ws.accept()
        except Exception:
            connections.pop(assigned,None); catalog.agents.pop(assigned,None); raise
        async def heartbeat():
            while True:
                await asyncio.sleep(8)
                try:
                    await db('authenticate',bearer(ws.headers),'device')
                    if time.monotonic()-last_seen>35: await ws.close(code=4408,reason='Heartbeat expired'); return
                    await agent.send('heartbeat',{'protocol':PROTOCOL})
                except HTTPException as exc:
                    await ws.close(code=1013 if exc.status_code==503 else 4401,reason='Database temporarily unavailable' if exc.status_code==503 else 'Device credentials revoked'); return
                except Exception: return
        last_seen=time.monotonic(); heartbeat_task=asyncio.create_task(heartbeat())
        try:
            await agent.send('welcome',{'agent_id':assigned,'device_id':user['device'],'owner_id':user['owner'],'protocol':PROTOCOL})
            message_window=time.monotonic(); message_count=0
            while True:
                raw=await ws.receive_text(); last_seen=time.monotonic()
                if last_seen-message_window>60: message_window=last_seen; message_count=0
                message_count+=1
                if message_count>240: await ws.close(code=4429,reason='Message rate limit reached'); break
                if len(raw.encode())>MESSAGE_LIMIT: await ws.close(code=4400,reason='Message is too large'); break
                await db('authenticate',bearer(ws.headers),'device')
                msg=json.loads(raw); kind=msg.get('type'); data=msg.get('payload',{})
                if not isinstance(data,dict): raise ValueError('Invalid protocol payload')
                if kind=='hello':
                    if data.get('protocol')!=PROTOCOL: await ws.close(code=4406,reason='Bridge protocol update required'); break
                    agent.platform=str(data.get('platform','unknown'))[:160]
                    agent.display_name=str(data.get('display_name') or provider)[:160]
                    agent.computer_name=str(data.get('hostname') or user['device'])[:160]
                    agent.capabilities=[f'{provider}.sessions','remote.sessions']
                    if data.get('execution_available') is True: agent.capabilities.append(f'{provider}.exec')
                    agent.catalog_status='scanning'; agent.catalog_error=''
                    await agent.send('reconcile_request',{'tasks':await db('list_tasks',user['owner'],user['device'],active=True)})
                elif kind=='session_catalog':
                    await catalog.handle_desktop_message(agent,msg)
                    await pump(user['owner'])  # Only still-queued DB tasks; uncertain deliveries are never retried.
                elif kind in {'ack','task_state','result','reconcile'}:
                    task_id=msg.get('task_id'); task=await db('get_task',user['owner'],task_id)
                    if task['device_id']!=user['device'] or task['target_agent']!=assigned: raise HTTPException(403,'Task is outside this device scope')
                    if kind=='ack': await db('transition',user['owner'],task_id,'received',verified_delivery=True)
                    elif kind=='task_state' and data.get('status') in {'waiting','running','cancelling','cleanup-unconfirmed'}:
                        agent.status=data['status']; agent.active_task_id=task_id
                        await db('transition',user['owner'],task_id,data['status'],execution_status=data['status'],verified_delivery=True,
                            execution_connection=agent.connection_id,execution_revision=catalog.next_receipt_revision())
                    elif kind=='result':
                        clean={key:data[key] for key in ('ok','cancelled','cleanup_confirmed','stdout','stderr','json','error','exit_code') if key in data}
                        if len(json.dumps(clean,ensure_ascii=False).encode('utf-8'))>48*1024: raise ValueError('Feedback is too large')
                        confirmed=clean.get('cleanup_confirmed') is True
                        if agent.active_task_id in {None,task_id}:
                            agent.status='idle' if confirmed else 'cleanup-unconfirmed'; agent.active_task_id=None if confirmed else task_id
                        status='cleanup-unconfirmed' if not confirmed else 'cancelled' if clean.get('cancelled') else 'done' if clean.get('ok') else 'failed'
                        await db('transition',user['owner'],task_id,status,result=clean,error=clean.get('error',''),execution_status='idle' if confirmed else 'cleanup-unconfirmed',
                            execution_connection=agent.connection_id,execution_revision=catalog.next_receipt_revision())
                        await agent.send('result_ack',{},task_id=task_id)
                        await pump(user['owner'])
                    elif kind=='reconcile':
                        # Unknown delivery is never interpreted as permission to rerun.
                        if data.get('known') is False and task['status']!='queued':
                            await db('transition',user['owner'],task_id,'delivery-uncertain',error='Bridge has no durable receipt; execution outcome is unknown')
                        elif data.get('known') is True and task['status']=='delivery-uncertain':
                            await db('transition',user['owner'],task_id,'received',verified_delivery=True,error='')
                    if kind!='result':
                        latest=await db('get_task',user['owner'],task_id)
                        if latest['status'] not in FINAL and latest.get('cancel_requested'): await agent.send('cancel',{},task_id=task_id)
                elif kind!='pong': raise ValueError('Unsupported public protocol message')
        except (WebSocketDisconnect, ValueError, HTTPException) as exc:
            try: await ws.close(code=1013 if isinstance(exc,HTTPException) and exc.status_code==503 else 4400,reason='Connection ended or protocol rejected')
            except Exception: pass
        finally:
            heartbeat_task.cancel(); await asyncio.gather(heartbeat_task,return_exceptions=True)
            if connections.get(assigned)==entry:
                connections.pop(assigned,None); catalog.agents.pop(assigned,None)
            agent.catalog_event.set()
            log.info('device disconnected')

    return app

app=create_app()

if __name__=='__main__':
    import uvicorn
    uvicorn.run(app,host='0.0.0.0',port=int(os.getenv('PORT','8787')),workers=1,
                ws_max_size=MESSAGE_LIMIT,ws_max_queue=8,timeout_keep_alive=15,access_log=False)
