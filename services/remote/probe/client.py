"""Desktop header/Upgrade/heartbeat/idle/reconnect probe; token comes from env."""
import argparse
import asyncio
import json
import os
import ssl
import time
from urllib.parse import urlsplit
import httpx
import websockets
async def run(args):
    url=urlsplit(args.url)
    if url.scheme!='https' and not (args.loopback and url.scheme=='http' and url.hostname in {'localhost','127.0.0.1'}):
        raise ValueError('HTTPS/WSS required; --loopback permits only isolated local HTTP tests')
    if url.username or url.password or url.query or url.fragment: raise ValueError('URL must not contain secrets or query parameters')
    token=os.environ.get('PROBE_TOKEN','')
    if len(token)<20: raise ValueError('Set a disposable PROBE_TOKEN of at least 20 random characters')
    context=ssl.create_default_context(cafile=args.ca) if url.scheme=='https' else None
    base=args.url.rstrip('/'); socket=('wss' if url.scheme=='https' else 'ws')+base[base.index(':'):]+'/probe/socket'
    async with httpx.AsyncClient(verify=context or True,trust_env=False,follow_redirects=False,timeout=15) as client:
        response=await client.get(base+'/health'); response.raise_for_status()
        if response.json().get('probe') is not True: raise ValueError('This is not the disposable probe service')
        print(json.dumps({'https_health':True,'boot_id':response.json()['boot_id']}),flush=True)
    options={'ssl':context} if context else {}
    try:
        async with websockets.connect(socket,additional_headers={'Authorization':'Bearer deliberately-invalid-probe-token'},max_size=4096,**options):
            raise ValueError('Unauthenticated probe connection was accepted')
    except websockets.exceptions.InvalidStatus as error:
        if error.response.status_code!=401 or error.response.headers.get('X-AhaStation-Auth-Error')!='invalid-credential':
            raise ValueError('Public entry did not preserve the Hub authorization rejection status/header')
        print(json.dumps({'unauthorized_rejected':True,'auth_error_header_preserved':True}),flush=True)
    end=time.monotonic()+args.seconds; reconnects=0; acknowledgements=0; first=True; delay=1
    while time.monotonic()<end:
        try:
            options={'ssl':context} if context else {}
            async with websockets.connect(socket,additional_headers={'Authorization':'Bearer '+token},ping_interval=None,max_size=4096,**options) as ws:
                welcome=json.loads(await asyncio.wait_for(ws.recv(),10))
                if welcome.get('authorization_header_present') is not True or welcome.get('path')!='/probe/socket': raise ValueError('Path/header forwarding failed')
                print(json.dumps({'wss_connected':True,'boot_id':welcome['boot_id'],'reconnects':reconnects}),flush=True)
                delay=1
                if first and args.idle: await asyncio.sleep(min(args.idle,max(0,end-time.monotonic())))
                first=False
                while time.monotonic()<end:
                    await ws.send(json.dumps({'type':'heartbeat','sequence':acknowledgements}))
                    answer=json.loads(await asyncio.wait_for(ws.recv(),15))
                    if answer.get('type')!='heartbeat_ack' or answer.get('sequence')!=acknowledgements: raise ValueError('Heartbeat response mismatched')
                    acknowledgements+=1
                    await asyncio.sleep(min(5,max(0,end-time.monotonic())))
        except (OSError,TimeoutError,websockets.exceptions.ConnectionClosed) as error:
            reconnects+=1; print(json.dumps({'reconnecting':True,'error_type':type(error).__name__}),flush=True)
            await asyncio.sleep(min(delay,max(0,end-time.monotonic()))); delay=min(delay*2,30)
    print(json.dumps({'heartbeat_acks':acknowledgements,'reconnects':reconnects,'completed':acknowledgements>0}),flush=True)
    if acknowledgements==0: raise RuntimeError('No verified desktop heartbeat acknowledgement')
if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--url',required=True); parser.add_argument('--seconds',type=float,default=300)
    parser.add_argument('--idle',type=float,default=60); parser.add_argument('--ca'); parser.add_argument('--loopback',action='store_true')
    asyncio.run(run(parser.parse_args()))
