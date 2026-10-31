"""Temporary Hub for two real Node Station services; exits when stdin closes."""
import asyncio
import json
import sys
import socket
import uvicorn
from sqlalchemy import update
from test_station_collaboration import StationCollaborationTest
from public_hub import create_app
from hub_store import credentials,HubStore
from sqlalchemy import create_engine
async def main():
    fixture=StationCollaborationTest(methodName='test_generation_snapshot_boundary_wss_and_protocol_rejection')
    await fixture.asyncSetUp()
    try:
        print(json.dumps({'ready':True,'url':fixture.url,'owner':fixture.account['owner_id'],'token':fixture.account['control_token']}),flush=True)
        while True:
            command=(await asyncio.to_thread(sys.stdin.readline)).strip()
            if command.startswith('expire-device '):
                identity=command.split(' ',1)[1]
                with fixture.engine.begin() as c:c.execute(update(credentials).where(credentials.c.device==identity,credentials.c.scope=='station').values(expires=0))
                print(json.dumps({'expired':identity}),flush=True);continue
            if command!='restart':break
            port=fixture.socket.getsockname()[1];fixture.server.should_exit=True
            await asyncio.wait_for(fixture.serving,15);fixture.socket.close()
            fixture.socket=socket.socket();fixture.socket.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);fixture.socket.bind(('127.0.0.1',port))
            url=fixture.engine.url;fixture.engine.dispose();fixture.engine=create_engine(url);fixture.store=HubStore(fixture.engine,'test-only-collaboration-secret-at-least-32');fixture.store.ready()
            fixture.app=create_app(fixture.store)
            fixture.server=uvicorn.Server(uvicorn.Config(fixture.app,log_level='critical',lifespan='on'))
            fixture.serving=asyncio.create_task(fixture.server.serve(sockets=[fixture.socket]))
            for _ in range(500):
                if fixture.server.started:break
                await asyncio.sleep(.01)
            print(json.dumps({'restarted':True}),flush=True)
    finally: await fixture.asyncTearDown()
if __name__=='__main__': asyncio.run(main())
