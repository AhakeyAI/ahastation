import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { SharedCommand } from './production-types.js';
import { checkJson, parseContract } from './validation.js';
const ajv = new Ajv2020({ strict: true, allErrors: false });
ajv.addSchema(JSON.parse(readFileSync(new URL('../../contracts/collaboration/v1.schema.json', import.meta.url),'utf8')));
const check = ajv.compile(JSON.parse(readFileSync(new URL('../../contracts/collaboration/v2.schema.json', import.meta.url),'utf8')));
const wireSnapshot=ajv.compile({$ref:'https://ahastation.local/contracts/collaboration/v2.schema.json#/$defs/wireSnapshot'});
const wireEvent=ajv.compile({$ref:'https://ahastation.local/contracts/collaboration/v2.schema.json#/$defs/wireEvent'});
const messageReceipt=ajv.compile({$ref:'https://ahastation.local/contracts/collaboration/v2.schema.json#/$defs/messageSubmissionReceipt'});
const artifactManifest=ajv.compile({$ref:'https://ahastation.local/contracts/collaboration/v2.schema.json#/$defs/textArtifactManifest'});
const artifactStatus=ajv.compile({$ref:'https://ahastation.local/contracts/collaboration/v2.schema.json#/$defs/textArtifactStatus'});
const artifactChunk=ajv.compile({$ref:'https://ahastation.local/contracts/collaboration/v2.schema.json#/$defs/textArtifactChunk'});
export class CollaborationProtocolError extends Error {}
export function validateSharedWire(kind:'snapshot'|'event'|'message-receipt'|'text-manifest'|'text-status'|'text-chunk',value:unknown):void {
  if(!(kind==='snapshot'?wireSnapshot:kind==='event'?wireEvent:kind==='text-manifest'?artifactManifest:kind==='text-status'?artifactStatus:kind==='text-chunk'?artifactChunk:messageReceipt)(value))throw new CollaborationProtocolError('协作服务返回未支持的数据协议，已停止执行，请更新或核对服务版本');
}
export function parseSharedCommand(value: unknown): SharedCommand {
  checkJson(value);
  if((value as {protocol?:unknown})?.protocol!==2)throw new Error('协作协议不兼容，请更新 Station');
  if(Buffer.byteLength(JSON.stringify(value),'utf8')>64000)throw new Error('协作请求超过64000字节，请减少本次输入；完整文字成果使用32KiB原始字节分片');
  if(!check(value))throw new Error('协作请求字段无效，请检查目标、准确提交号和权限设置');
  const command=structuredClone(value) as SharedCommand;
  if(command.action==='device.register'||command.action==='device.update')parseContract('deviceConfig',command.payload.config);
  if(command.action==='project.create'&&(command.payload.config as {repository?:unknown})?.repository)parseContract('projectConfig',command.payload.config);
  if(command.action==='binding.report')parseContract('bindingReport',command.payload);
  return command;
}
