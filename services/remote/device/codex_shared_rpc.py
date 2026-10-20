"""Local app-server JSON-RPC client. Never starts an independent exec process."""
from __future__ import annotations
import asyncio
import json
import uuid
from websockets.asyncio.client import connect


class RPC:
    def __init__(self, url, name='ahastation_bridge', headers=None):
        self.url=url; self.name=name; self.headers=headers
        self.pending={}; self.events=asyncio.Queue(); self.ws=None; self.reader=None

    async def __aenter__(self):
        self.ws=await connect(self.url, additional_headers=self.headers, max_size=16*1024*1024,close_timeout=1)
        self.reader=asyncio.create_task(self._read())
        try:
            self.info=await self.call('initialize',{'clientInfo':{'name':self.name,'version':'0.2.0'},
                'capabilities':{'experimentalApi':True}})
            await self.ws.send(json.dumps({'method':'initialized'}))
        except BaseException:
            await self.__aexit__(); raise
        return self

    async def _read(self):
        try:
            async for raw in self.ws:
                message=json.loads(raw)
                if 'method' not in message and message.get('id') in self.pending:
                    future=self.pending.pop(message['id'])
                    if not future.done():
                        if 'error' in message: future.set_exception(RuntimeError(str(message['error'])))
                        else: future.set_result(message.get('result'))
                else: await self.events.put(message)
        finally:
            for future in self.pending.values():
                if not future.done(): future.set_exception(ConnectionError('Shared app-server connection ended; task outcome unconfirmed'))
            self.pending.clear()
            await self.events.put({'method':'bridge/connectionLost'})

    async def call(self, method, params=None, timeout=30):
        request=str(uuid.uuid4()); future=asyncio.get_running_loop().create_future()
        self.pending[request]=future
        try:
            await self.ws.send(json.dumps({'id':request,'method':method,'params':params or {}}))
            return await asyncio.wait_for(asyncio.shield(future),timeout)
        finally:
            self.pending.pop(request,None)
            if not future.done(): future.cancel()

    async def __aexit__(self,*args):
        if self.ws: await self.ws.close()
        if self.reader: await asyncio.gather(self.reader,return_exceptions=True)
