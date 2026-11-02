import {readFile,writeFile} from 'node:fs/promises';
const folder=process.argv[3]??'runtime/collaboration-2026-10-21';
const baselineName=process.argv[4]??'baseline-node.log';
const current=process.argv[2]??'final-node-candidate.log';
function parse(log){
  const counts=Object.fromEntries([...log.matchAll(/^ℹ (tests|pass|fail|skipped) (\d+)\r?$/gm)].map(m=>[m[1],Number(m[2])]));
  const failures=[...new Set([...log.matchAll(/^✖ (.+) \([\d.]+ms\)\r?$/gm)].map(m=>m[1]))].sort();
  const reasons={};const details=log.split('✖ failing tests:')[1]??'';
  for(const block of details.split(/\r?\ntest at /).slice(1)){
    const name=/^✖ (.+) \([\d.]+ms\)\r?$/m.exec(block)?.[1];if(!name)continue;
    const message=/^  (?:Error|AssertionError|TypeError|RangeError|AggregateError)[^\r\n]*/m.exec(block)?.[0].trim()??'See raw failure log';
    const code=/^\s+code: ['"]([^'"]+)/m.exec(block)?.[1];reasons[name]={message,...(code?{code}:{})};
  }
  if(!counts.tests||failures.length!==counts.fail)throw new Error('Incomplete test log or failure list');
  return {...counts,failures,reasons};
}
const baseline=parse(await readFile(`${folder}/${baselineName}`,'utf8'));
const candidate=parse(await readFile(`${folder}/${current}`,'utf8'));
const report={baselineLog:baselineName,candidateLog:current,baseline,candidate,
  newFailures:candidate.failures.filter(n=>!baseline.failures.includes(n)),
  removedFailures:baseline.failures.filter(n=>!candidate.failures.includes(n))};
const comparable=reason=>JSON.stringify(reason).replace(/([\\/](?:Temp|tmp)[\\/])[^\\/'" ]+/g,'$1<owned-temp>');
report.changedReasons=candidate.failures.filter(n=>baseline.reasons[n]&&comparable(baseline.reasons[n])!==comparable(candidate.reasons[n])).map(name=>({name,baseline:baseline.reasons[name],candidate:candidate.reasons[name]}));
await writeFile(`${folder}/baseline-comparison.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({baseline:baseline.tests,baselineFailures:baseline.fail,candidate:candidate.tests,candidatePass:candidate.pass,candidateFailures:candidate.fail,newFailures:report.newFailures}));
if(report.newFailures.length)process.exitCode=1;
