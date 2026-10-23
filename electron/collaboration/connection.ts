import WebSocket from 'ws';
import { collaborationFetch, websocketProxy } from './network.js';
import { validateSharedWire, CollaborationProtocolError } from './production-validation.js';
import type { SharedCommand, SharedEvent, SharedSnapshot } from './production-types.js';
export interface ConnectionOptions {
  url: string; token: string;
  deviceId?:string;
  onSnapshot(value: SharedSnapshot,current?:()=>boolean): Promise<void>;
  onEvent(event: SharedEvent,current?:()=>boolean): Promise<void>;
  onStatus(connected: boolean, error?: string,credentialInvalid?:boolean): void;
  onReady?(): Promise<void>;
}
export class CollaborationHttpError extends Error {constructor(message:string,readonly status:number,readonly code?:string){super(message);}}
export const STATION_FEATURES='unified-meeting-v1,unified-review-fixes-v1,unified-stability-v1,unified-hardening-v1';
export class CollaborationConnection {
  private socket?: WebSocket; private epoch = 0; private retry = 0;
  private timer?: ReturnType<typeof setTimeout>; private heartbeat?: ReturnType<typeof setInterval>;
  private draining?: {epoch:number;promise:Promise<void>}; private dirty = false; private cursor = 0; private generation?: number;
  connected = false;
  constructor(private options: ConnectionOptions) {}
  async request(route: string, body?: SharedCommand): Promise<unknown> {
    const epoch=this.epoch;
    const response = await collaborationFetch(this.options.url + route, {
      method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + this.options.token,'X-Station-Features':STATION_FEATURES,
        ...(this.options.deviceId?{'X-Station-Device':this.options.deviceId}:{}),
        ...(body ? {'Content-Type':'application/json'} : {}),
        ...(this.generation ? {'X-Station-Generation':String(this.generation)} : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { detail?: string|{code?:string;message?:string} };
      const code=typeof error.detail==='object'?error.detail?.code:undefined;
      let invalid=response.status===401||code==='AUTH_INVALID';
      // Older Hubs used an undifferentiated 403. Snapshot has no operation
      // permission gate, so verify the same token there before invalidating it.
      if(response.status===403&&!code){
        try{const proof=await collaborationFetch(this.options.url+'/api/collaboration/v2/snapshot',{headers:{Authorization:'Bearer '+this.options.token,'X-Station-Features':STATION_FEATURES},signal:AbortSignal.timeout(15000)});invalid=proof.status===401||proof.status===403;await proof.body?.cancel();}catch{}
      }
      if(invalid&&epoch===this.epoch)this.invalidate();
      throw new CollaborationHttpError((typeof error.detail==='string'?error.detail:error.detail?.message)??`协作服务请求失败 (${response.status})`,response.status,code);
    }
    if(!response.body)throw new Error('协作服务返回空响应');
    const reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
    for(;;){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>16*1024*1024){await reader.cancel();throw new Error('协作响应超过限额，请核对账号资料量');}chunks.push(chunk.value);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  private invalidate(){this.stop();this.options.onStatus(false,'协作凭证已失效，请重新登录并核对原任务',true);}
  async validateCredential(deviceId:string):Promise<SharedSnapshot>{
    const identity=await this.request('/api/collaboration/v2/identity') as {deviceId?:string};
    if(identity.deviceId!==deviceId){this.invalidate();throw new Error('服务端凭证身份与原设备不匹配，保留原任务待核对');}
    const snapshot=await this.request('/api/collaboration/v2/snapshot') as SharedSnapshot;validateSharedWire('snapshot',snapshot);
    const own=snapshot.entities.device.find(d=>d.id===deviceId);
    if(!own||own.revoked){this.invalidate();throw new Error('服务端未确认原设备身份有效，请核对撤销状态');}
    return snapshot;
  }
  command(command: SharedCommand): Promise<unknown> { return this.request('/api/collaboration/v2/commands',command); }
  start(): void { this.stop(); const epoch = ++this.epoch; this.connect(epoch); }
  stop(): void {
    ++this.epoch; clearTimeout(this.timer); clearInterval(this.heartbeat);
    this.socket?.close(); this.socket=undefined; this.connected=false; this.generation=undefined;
  }
  private connect(epoch: number): void {
    if (epoch !== this.epoch) return;
    const socket = new WebSocket(this.options.url.replace(/^http/,'ws') + '/ws/station?protocol=2', {
      headers:{ Authorization:'Bearer '+this.options.token,...(this.options.deviceId?{'X-Station-Device':this.options.deviceId}:{}) }, maxPayload:65536, handshakeTimeout:15000,
      agent:websocketProxy(this.options.url),
    });
    this.socket=socket;
    let lastPong=Date.now(); let ready=false;
    socket.on('message', raw => {
      if (epoch!==this.epoch || socket!==this.socket) return;
      void (async () => {
        const message=JSON.parse(String(raw)) as {protocol:number;type:string;generation:number};
        if (message.protocol!==2||!['ready','pong','changed'].includes(message.type)||!Number.isSafeInteger(message.generation)||message.generation<1) throw new CollaborationProtocolError('协作通知协议不兼容，请更新 Station');
        if (message.type==='ready') {
          if(ready)throw new CollaborationProtocolError('重复的协作连接握手');
          this.generation=message.generation;
          const snapshot=await this.request('/api/collaboration/v2/snapshot') as SharedSnapshot;
          if (epoch!==this.epoch) return;
          if(snapshot.protocol!==2) throw new Error('快照协议不兼容');
          validateSharedWire('snapshot',snapshot);
          await this.options.onSnapshot(snapshot,()=>epoch===this.epoch&&socket===this.socket);if(epoch!==this.epoch)return;this.cursor=snapshot.cursor;
          await this.drain(epoch); if (epoch!==this.epoch) return;
          ready=true; this.retry=0; this.connected=true; this.options.onStatus(true);
          this.heartbeat=setInterval(() => {
            if (Date.now()-lastPong>40000) { socket.close(); return; }
            if (socket.readyState===WebSocket.OPEN) socket.send(JSON.stringify({protocol:2,type:'ping',generation:this.generation}));
          },15000);
          await this.options.onReady?.();
        } else if (message.generation===this.generation && message.type==='pong') lastPong=Date.now();
        else if (message.generation===this.generation && message.type==='changed' && ready) await this.drain(epoch);
      })().catch(error => { if(epoch!==this.epoch||socket!==this.socket)return;this.options.onStatus(false,error instanceof Error ? error.message : '协作连接失败'); socket.close(error instanceof CollaborationProtocolError||error instanceof SyntaxError||error instanceof CollaborationHttpError&&error.status===426?4406:1013); });
    });
    socket.on('error', () => {});
    socket.on('unexpected-response',(_request,response)=>{
      response.resume();
      if(epoch!==this.epoch)return;
      if(response.statusCode===401){this.invalidate();return;}
      if(response.statusCode===403){void this.request('/api/collaboration/v2/snapshot').catch(()=>{}).finally(()=>{if(epoch===this.epoch)socket.terminate();});return;}
      socket.terminate();
    });
    socket.on('close', code => {
      if (epoch!==this.epoch) return;
      clearInterval(this.heartbeat); this.connected=false;
      this.options.onStatus(false,code===4401 ? '设备凭证失效，请重新登录' : code===4406 ? '协作协议不兼容，请更新 Station' : '连接中断，正在核对原任务',code===4401);
      if (code===4401 || code===4406 || code===4001) return;
      const next=++this.epoch;
      this.timer=setTimeout(() => {if(next===this.epoch)this.connect(next);},Math.min(30000,500*2**Math.min(this.retry++,6))+Math.random()*250);
    });
  }
  private drain(epoch: number): Promise<void> {
    this.dirty=true;
    if (this.draining?.epoch===epoch) return this.draining.promise;
    const promise=(async () => {
      while(this.dirty && epoch===this.epoch) {
        this.dirty=false;
        const page=await this.request('/api/collaboration/v2/events?after='+this.cursor) as {protocol:number;cursor:number;events:SharedEvent[]};
        if (epoch!==this.epoch) return;
        if(page.protocol!==2) throw new Error('事件协议不兼容');
        for(const event of page.events) {
          validateSharedWire('event',event);
          if(event.seq<=this.cursor) continue;
          if(event.seq!==this.cursor+1) throw new Error('事件缺口，需要重新连接获取快照');
          await this.options.onEvent(event,()=>epoch===this.epoch);if(epoch!==this.epoch)return;this.cursor=event.seq;
        }
        if (this.cursor<page.cursor) this.dirty=true;
      }
    })().finally(() => { if(this.draining?.epoch===epoch)this.draining=undefined; });
    this.draining={epoch,promise};return promise;
  }
}
