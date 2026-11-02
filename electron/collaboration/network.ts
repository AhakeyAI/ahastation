import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
const proxy = new EnvHttpProxyAgent();
const loopback=(value:string)=>['127.0.0.1','localhost','[::1]'].includes(new URL(value).hostname);
export const collaborationFetch: typeof fetch = (async(input: string | URL | Request, init?: RequestInit) => {
  const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
  const response=await undiciFetch(url,{...init as Parameters<typeof undiciFetch>[1],redirect:'error',...(loopback(url)?{}:{dispatcher:proxy})});
  return response as unknown as Response;
}) as typeof fetch;
export function websocketProxy(url: string): HttpsProxyAgent<string>|undefined {
  if(loopback(url))return undefined;
  const noProxy=process.env.NO_PROXY??process.env.no_proxy??'';const hostname=new URL(url).hostname;
  if(noProxy.split(',').some(part=>{const host=part.trim();return host==='*'||host===hostname||host.startsWith('.')&&hostname.endsWith(host);}))return undefined;
  const value=process.env.HTTPS_PROXY??process.env.https_proxy??process.env.ALL_PROXY;
  return value?new HttpsProxyAgent(value):undefined;
}
