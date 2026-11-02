import {spawnSync} from 'node:child_process';
const candidates=process.env.AHASTATION_BUILD_PYTHON?[[process.env.AHASTATION_BUILD_PYTHON]]:
  process.platform==='win32'?[['python'],['py','-3.13']]:[['python3']];
for(const [binary,...prefix] of candidates){
  const probe=spawnSync(binary,[...prefix,'-c','import sys,PyInstaller;assert sys.version_info>=(3,11)'],{windowsHide:true,stdio:'ignore'});
  if(probe.status!==0)continue;
  const result=spawnSync(binary,[...prefix,'scripts/build-station-native.py'],{windowsHide:true,stdio:'inherit'});
  process.exit(result.status??1);
}
console.error('Building the bundled receiver requires Python 3.11+ and services/remote/requirements-station-native.txt. Set AHASTATION_BUILD_PYTHON to the build interpreter; installed users do not need Python.');
process.exit(1);
