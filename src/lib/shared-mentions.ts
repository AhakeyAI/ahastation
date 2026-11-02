/** A selected mention is a text range plus a stable identity. Display labels
 * may change independently; they are never searched to infer a recipient. */
export interface SharedMention {start:number;end:number;text:string;memberId:string;deviceId:string;agentId:string;nativeSessionId?:string}
export interface MentionMember {id:string;deviceId:string;agentId:string;nativeSessionId?:string;label:string;online:boolean}
export function bindSharedMention(member:MentionMember,start:number):SharedMention{
  const text='@'+member.label;return {start,end:start+text.length,text,memberId:member.id,deviceId:member.deviceId,agentId:member.agentId,...(member.nativeSessionId?{nativeSessionId:member.nativeSessionId}:{})};
}
/** Preserve ranges only across edits outside their text. Editing a label
 * removes its binding; any remaining explicit @ must be selected again. */
export function editSharedMentions(before:string,after:string,mentions:SharedMention[]):SharedMention[]{
  let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;
  let end=before.length,nextEnd=after.length;while(end>start&&nextEnd>start&&before[end-1]===after[nextEnd-1]){end--;nextEnd--;}
  const shift=nextEnd-end;
  return mentions.flatMap(m=>{
    if(before.slice(m.start,m.end)!==m.text)return [];
    if(end<=m.start)return [{...m,start:m.start+shift,end:m.end+shift}];
    if(start>=m.end)return [m];
    return [];
  }).filter(m=>after.slice(m.start,m.end)===m.text);
}
export function resolveSharedMention(text:string,mentions:SharedMention[],members:MentionMember[]):MentionMember|undefined{
  const ranges=[...mentions].sort((a,b)=>a.start-b.start);const selected:MentionMember[]=[];let masked=text;let lastEnd=-1;
  for(const mention of ranges){
    if(mention.start<0||mention.start<lastEnd||mention.end<=mention.start||text.slice(mention.start,mention.end)!==mention.text)throw new Error('@ 绑定已被编辑，请重新选择准确成员');
    const member=members.find(m=>m.id===mention.memberId&&m.deviceId===mention.deviceId&&m.agentId===mention.agentId&&m.nativeSessionId===mention.nativeSessionId);
    if(!member)throw new Error('@ 成员已离会或对话已失效，请重新选择');
    if(!member.online)throw new Error('@ 成员当前离线，请恢复连接或重新选择；草稿已保留');
    selected.push(member);masked=masked.slice(0,mention.start)+' '.repeat(mention.end-mention.start)+masked.slice(mention.end);lastEnd=mention.end;
  }
  // Stable tokens are retained for the existing voice/API route. Pasted human
  // labels have no binding and must be explicitly selected, including Chinese.
  for(const match of masked.matchAll(/(?:^|\s)@([^\s,，:：]+)/gu)){
    const member=members.find(m=>m.id===match[1]);
    if(!member)throw new Error('请从 @ 候选重新选择准确设备、Agent 或原生对话');
    if(!member.online)throw new Error('@ 成员当前离线，请恢复连接后发送');selected.push(member);
  }
  if(new Set(selected.map(m=>m.id)).size>1)throw new Error('每条消息请选择一个明确讨论对象');
  return selected[0];
}
