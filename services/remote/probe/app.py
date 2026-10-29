"""Disposable ordinary HTTP/WSS probe. No business data, database or real token."""
import asyncio
import hmac
import json
import os
import uuid
from fastapi import FastAPI,WebSocket,WebSocketDisconnect
from fastapi.responses import JSONResponse
app=FastAPI(docs_url=None,redoc_url=None,openapi_url=None)
BOOT=str(uuid.uuid4())
@app.get('/health')
async def health(): return {'ok':True,'probe':True,'boot_id':BOOT}
@app.websocket('/probe/socket')
async def socket(ws:WebSocket):
    expected=os.environ.get('PROBE_TOKEN','')
    if len(expected)<20 or not hmac.compare_digest(ws.headers.get('authorization',''),'Bearer '+expected):
        return await ws.send_denial_response(JSONResponse({'detail':'Disposable probe authorization rejected'},401,headers={'X-AhaStation-Auth-Error':'invalid-credential'}))
    await ws.accept()
    await ws.send_json({'type':'welcome','boot_id':BOOT,'path':ws.url.path,'authorization_header_present':True})
    try:
        while True:
            raw=await asyncio.wait_for(ws.receive_text(),timeout=180)
            if len(raw.encode())>4096: await ws.close(code=4400); return
            payload=json.loads(raw)
            if payload.get('type')!='heartbeat': await ws.close(code=4400); return
            await ws.send_json({'type':'heartbeat_ack','sequence':payload.get('sequence'),'boot_id':BOOT})
    except (WebSocketDisconnect,asyncio.TimeoutError,ValueError):
        try: await ws.close()
        except RuntimeError: pass
if __name__=='__main__':
    import uvicorn
    uvicorn.run(app,host='0.0.0.0',port=int(os.getenv('PORT','8787')),access_log=False,ws_max_size=4096,ws_max_queue=4)
