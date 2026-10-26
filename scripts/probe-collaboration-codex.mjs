import {CodexBackend} from '../dist-electron/backends/codex-adapter.js';
import {CodexAppServerTransport} from '../dist-electron/backends/codex-app-server-transport.js';
const backend=new CodexBackend();const transport=new CodexAppServerTransport({binaryPath:backend.resolveBinary(),env:backend.buildEnv({authMode:'oauth'})});
try {
  const ready=await transport.start();const models=await transport.call('model/list',{limit:100,includeHidden:false});
  console.log(JSON.stringify({runtime:ready.userAgent,models:models.data?.map(m=>({id:m.id,model:m.model,isDefault:m.isDefault}))}));
}finally{transport.close();}
