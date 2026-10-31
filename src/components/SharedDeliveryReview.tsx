import {textSlice} from '../../electron/collaboration/text-slice';
import {useEffect,useRef,useState} from 'react';
import type {SharedEntity,TextArtifactManifest} from '../../electron/collaboration/production-types';
import {browserDeliveryHash,deliveryIdentity} from '../../electron/collaboration/delivery-identity';
import {sharedRequest} from '../lib/unified-meeting-store';
import {toast} from '../lib/toast';
export function SharedDeliveryReview({captured,current,onClose}:{captured:SharedEntity;current:SharedEntity;onClose:()=>void}){
  const submission=useRef(false);
  const [evidence,setEvidence]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[body,setBody]=useState<string>(),[page,setPage]=useState(0),[loading,setLoading]=useState(false);
  const d=captured.delivery as {summary?:string;textArtifact?:TextArtifactManifest;report?:{tests?:Array<{argv:string[];exitCode:number|null;output:string}>;unresolved?:string[]}};
  const changed=deliveryIdentity(captured)!==deliveryIdentity(current);const identity={meetingId:captured.meetingId,taskId:captured.id,attemptId:captured.attemptId};
  const load=async()=>{if(!d?.textArtifact)return;setLoading(true);setError('');try{const r=await sharedRequest('delivery.text',{...identity,artifactId:d.textArtifact.artifactId}) as {text:string};setBody(r.text);}catch(e){setError(String(e instanceof Error?e.message:e));}finally{setLoading(false);}};
  useEffect(()=>{void load();},[]);
  const submit=async()=>{if(submission.current||!evidence.trim()||changed)return;submission.current=true;setBusy(true);setError('');try{
    const deliveryHash=await browserDeliveryHash(captured);await sharedRequest('delivery.review',{...identity,deliveryHash,evidence:evidence.trim()});toast.success('本次准确成果的人工检查已记录');onClose();
  }catch(e){setError(String(e instanceof Error?e.message:e));}finally{submission.current=false;setBusy(false);}};
  return <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-label="记录当前成果人工验收" className="unified-dialog unified-review-dialog"><h2>检查本次准确成果</h2><p>任务 {captured.id} · attempt {String(captured.attemptId)}</p>
    {changed&&<p role="alert">成果或执行尝试已变化，原检查意见保留；请重新打开当前成果。</p>}
    <pre className="unified-review-body">{body===undefined?d?.summary??'尚无成果':textSlice(body,page*12000,(page+1)*12000)}</pre>
    {d?.textArtifact&&<><p>全文 {d.textArtifact.byteLength} 字节 · SHA256 {d.textArtifact.sha256} · {body===undefined?'尚未拉取核对':'已按总字节数和SHA核对'}</p><button disabled={loading||busy} onClick={()=>void load()}>{loading?'正在获取全文':'重新获取并核对全文'}</button>{body!==undefined&&<nav><button disabled={page===0} onClick={()=>setPage(n=>n-1)}>上一页</button><span>{page+1} / {Math.max(1,Math.ceil(body.length/12000))}</span><button disabled={(page+1)*12000>=body.length} onClick={()=>setPage(n=>n+1)}>下一页</button></nav>}</>}
    <h3>实际测试、未执行项与风险</h3>{d?.report?.tests?.length?d.report.tests.map((t,i)=><p key={i}>{t.argv.join(' ')}：{t.exitCode===0?'实际通过':t.exitCode===null?'未运行或未确认':'失败 '+t.exitCode}<pre>{t.output}</pre></p>):<p>未运行自动测试；人工说明不能替代工具审批或覆盖失败测试。</p>}{d?.report?.unresolved?.map((x,i)=><p key={i}>{x}</p>)}
    <label>实际人工检查说明<textarea autoFocus value={evidence} disabled={busy} onChange={e=>setEvidence(e.target.value)} placeholder="说明检查了什么、结果与未解决风险"/></label>{error&&<p role="alert">{error}</p>}
    <button disabled={busy||loading||!evidence.trim()||changed||(captured.resource==='text'&&body===undefined)} onClick={()=>void submit()}>{busy?'正在记录':'确认记录本次人工检查'}</button><button disabled={busy} onClick={onClose}>返回并保留原成果</button>
  </section></div>;
}
