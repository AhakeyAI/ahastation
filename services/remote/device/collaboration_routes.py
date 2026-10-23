"""One protocol for all Station platforms; HTTP state and resumable WS hints."""
import asyncio
import json
import time
import os
from fastapi import Request, WebSocket, HTTPException, WebSocketDisconnect
from collaboration_store import CollaborationStore, check

def install(app, db, principal):
    sockets={}
    app.state.station_connections=sockets
    def store(): return CollaborationStore(app.state.store(),lambda owner,device:(owner,device) in sockets)

    async def auth(request, scope='station'):
        try:
            user=await principal(request,scope)
            claimed=request.headers.get('x-station-device')
            if scope=='station' and claimed and claimed!=user.get('device'):raise HTTPException(401,'Station device identity does not match the credential')
            return user
        except HTTPException as exc:
            if exc.status_code in (401,403):raise HTTPException(401,{'code':'AUTH_INVALID','message':str(exc.detail)}) from exc
            raise

    @app.get('/api/collaboration/v2/identity')
    async def identity(request:Request):
        user=await auth(request)
        return {'deviceId':user['device'],'ownerId':user['owner']}

    @app.post('/api/collaboration/v2/commands')
    async def command(payload:dict,request:Request):
        check(payload)
        user=await auth(request,'control' if payload['action']=='device.register' else 'station')
        if os.getenv('HUB_MAINTENANCE')=='1' and (payload['action'] in ('task.create','task.receipt','message.receipt') or payload['action']=='task.control' and payload['payload']['operation'] in ('continue','advance')):
            # Repeated receipts for previously accepted work are still allowed.
            if payload['action'] not in ('task.receipt','message.receipt'):raise HTTPException(503,'Hub maintenance; new work waits, stop and reconciliation remain available')
            snapshot=await asyncio.to_thread(store().snapshot,user['owner'])
            rows=snapshot['entities']['task' if payload['action']=='task.receipt' else 'message']
            identity=payload['payload'].get('taskId') or payload['payload'].get('messageId')
            current=next((r for r in rows if r['id']==identity),{})
            if current.get('status')=='offered' or payload['action']=='message.receipt' and not current.get('executionStatus'):raise HTTPException(503,'Hub maintenance; unreceived work waits')
        if user.get('device'):
            entry=sockets.get((user['owner'],user['device']))
            generation=request.headers.get('x-station-generation')
            if generation is not None and (not entry or str(entry[1])!=generation): raise HTTPException(409,'Connection superseded; reconcile first')
        result=await asyncio.to_thread(store().command,user,payload)
        if payload['action'] in ('device.revoke','task.event','message.event'):
            for key,(socket,_) in list(sockets.items()):
                if key[0]!=user['owner']:continue
                try:await auth(socket)
                except HTTPException as exc:
                    if exc.status_code not in (401,403):continue
                    try:await socket.close(4401,'Device access revoked after execution cleanup')
                    except Exception:pass
        return result

    @app.get('/api/collaboration/v2/snapshot')
    async def snapshot(request:Request):
        user=await auth(request)
        value=await asyncio.to_thread(store().snapshot,user['owner'])
        features=set(request.headers.get('x-station-features','').split(','))
        if 'unified-hardening-v1' not in features and any('turnOutcome' in row for kind in ('task','message') for row in value['entities'][kind]):
            raise HTTPException(426,'Execution outcome protection requires Station collaboration.5 or later; preserve original device records')
        if 'unified-stability-v1' not in features and any(m.get('planProtocol')=='stability-v1' for m in value['entities']['meeting']):
            raise HTTPException(426,'Plan version protection requires Station collaboration.4 or later; reconcile existing work on its original device')
        if 'unified-review-fixes-v1' not in features and any(m.get('executionStatus') in ('preparing','failed') or m.get('retryOf') for m in value['entities']['message']):
            raise HTTPException(426,'Host input recovery requires Station collaboration.3 or later; existing identities and work remain preserved')
        if 'unified-meeting-v1' not in features:
            if any(m.get('hostAuthority')=='original-orchestrator' or any(k in m for k in ('participants','planBrief','mainProjectId')) for m in value['entities']['meeting']):
                raise HTTPException(426,'This account has unified meetings; update Station before resuming. Existing tasks remain on their original device.')
            value.pop('capabilities',None)
        return value

    @app.get('/api/collaboration/v2/message-receipts/{identity}')
    async def message_receipt(identity:str,request:Request):
        user=await auth(request)
        if not 1<=len(identity)<=80:raise HTTPException(400,'Invalid original submission identity')
        return await asyncio.to_thread(store().message_receipt,user,identity)

    @app.get('/api/collaboration/v2/message-receipts')
    async def message_receipt_query(requestId:str,request:Request):
        return await message_receipt(requestId,request)

    @app.get('/api/collaboration/v2/events')
    async def replay(request:Request,after:int=0):
        user=await auth(request)
        return await asyncio.to_thread(store().replay,user['owner'],after)

    @app.get('/api/collaboration/v2/history')
    async def history(request:Request,device:str,session:str,after:int=0):
        user=await auth(request)
        return await asyncio.to_thread(store().history,user['owner'],device,session,after)

    @app.websocket('/ws/station')
    async def station(ws:WebSocket,protocol:int=0):
        if protocol!=2:
            await ws.accept(); await ws.close(4406,'Collaboration protocol 2 required'); return
        try: user=await auth(ws)
        except HTTPException as exc:
            await ws.accept(); await ws.close(4401 if exc.status_code in (401,403) else 1013,'Station login required' if exc.status_code in (401,403) else 'Hub temporarily unavailable'); return
        key=(user['owner'],user['device']); service=store()
        await ws.accept()
        row=await asyncio.to_thread(service.connection,*key,True)
        generation=row['connectionGeneration']; old=sockets.get(key)
        sockets[key]=(ws,generation)
        if old:
            try: await old[0].close(4001,'Superseded by a new Station connection')
            except Exception: pass
        await ws.send_json({'protocol':2,'type':'ready','generation':generation})
        last_ping=time.monotonic()
        cursor=(await asyncio.to_thread(service.snapshot,user['owner']))['cursor']
        async def receive():
            nonlocal last_ping
            while True:
                msg=await ws.receive_text()
                if len(msg)>1024: raise ValueError('Heartbeat exceeds limit')
                value=json.loads(msg)
                if value!={'protocol':2,'type':'ping','generation':generation}: raise ValueError('Invalid heartbeat')
                if sockets.get(key)!=(ws,generation): return
                await db('authenticate',ws.headers.get('authorization','')[7:],'station')
                await asyncio.to_thread(service.heartbeat,*key,generation)
                last_ping=time.monotonic()
                await ws.send_json({'protocol':2,'type':'pong','generation':generation})
        receiver=asyncio.create_task(receive())
        close_code=1000
        try:
            while not receiver.done() and sockets.get(key)==(ws,generation):
                if time.monotonic()-last_ping>45: break
                page=await asyncio.to_thread(service.replay,user['owner'],cursor)
                # A bounded hint has no unique business state. Client drains HTTP
                # events to the durable cursor, including any events coalesced here.
                if page['cursor']>cursor:
                    await asyncio.wait_for(ws.send_json({'protocol':2,'type':'changed','cursor':page['cursor'],'generation':generation}),10)
                    cursor=page['cursor']
                await asyncio.sleep(.3)
            if receiver.done():await receiver
        except HTTPException as exc:close_code=4401 if exc.status_code in (401,403) else 1013
        except (ValueError,json.JSONDecodeError):close_code=4406
        except (WebSocketDisconnect,RuntimeError,asyncio.TimeoutError): pass
        finally:
            receiver.cancel(); await asyncio.gather(receiver,return_exceptions=True)
            if sockets.get(key)==(ws,generation):
                sockets.pop(key,None)
                await asyncio.to_thread(service.connection,*key,False,generation)
            try: await ws.close(close_code)
            except Exception: pass
