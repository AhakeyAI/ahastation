"""Station's actual public HTTP/WS/guardian roundtrip; temporary projects only."""
import asyncio
import json
import sys
from test_public_remote import PublicRemoteTest
async def main():
    fixture=PublicRemoteTest(methodName='test_native_two_turns_dedup_owner_isolation_and_real_cancel')
    await fixture.asyncSetUp()
    try:
        await fixture.connect()
        print(json.dumps({'ready':True,'url':fixture.url,'owner':fixture.owner,'token':fixture.a['control_token'],'target':fixture.target}),flush=True)
        await asyncio.to_thread(sys.stdin.readline)
    finally: await fixture.asyncTearDown()
if __name__=='__main__': asyncio.run(main())
