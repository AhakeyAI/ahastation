/** UTF-16 offsets, with adjacent page boundaries kept before a surrogate pair. */
export function textSlice(text:string,start=0,end=text.length):string {
  const offset=(n:number)=>Math.max(0,Math.min(text.length,n<0?text.length+n:n));
  const boundary=(n:number)=>n>0&&n<text.length&&text.charCodeAt(n)>=0xdc00&&text.charCodeAt(n)<=0xdfff&&text.charCodeAt(n-1)>=0xd800&&text.charCodeAt(n-1)<=0xdbff?n-1:n;
  return text.slice(boundary(offset(start)),boundary(offset(end)));
}
