"""Real Hub/Gateway transports with a controlled native protocol backend."""
import asyncio,json,sys
from pathlib import Path
from test_codex_shared import SharedTest
from test_station_collaboration import StationCollaborationTest
async def main():
    shared=SharedTest(methodName='test_cancel_waiting_does_not_interrupt_desktop');await shared.asyncSetUp()
    hub=StationCollaborationTest(methodName='test_generation_snapshot_boundary_wss_and_protocol_rejection');await hub.asyncSetUp()
    try:
        sessions=shared.folder/'sessions';sessions.mkdir();source=sessions/'fixture.jsonl';source.write_text(json.dumps({'type':'session_meta','payload':{'id':shared.thread,'cwd':str(shared.folder)}})+'\n',encoding='utf-8')
        shared.native.metadata[shared.thread]={'path':str(source),'preview':'Original native protocol fixture'}
        shared.native.catalog_rows=[{'id':shared.thread,'cwd':str(shared.folder)}]
        original=await shared.desktop_start()
        print(json.dumps({'ready':True,'url':hub.url,'owner':hub.account['owner_id'],'token':hub.account['control_token'],'sessionId':shared.thread,'projectRoot':str(shared.folder),'nativeState':str(shared.folder/'state'),'desktopTurn':original}),flush=True)
        while True:
            command=(await asyncio.to_thread(sys.stdin.readline)).strip()
            if command=='finish-desktop':await shared.native.finish(shared.thread)
            elif command=='interrupt-current':
                turn=shared.native.active[shared.thread]['id'];await shared.desktop.call('turn/interrupt',{'threadId':shared.thread,'turnId':turn})
            elif command=='status':print(json.dumps({'status':True,'starts':len(shared.native.starts),'interrupts':len(shared.native.interrupts),'active':shared.thread in shared.native.active}),flush=True)
            else:break
    finally:await hub.asyncTearDown();await shared.asyncTearDown()
if __name__=='__main__':asyncio.run(main())
