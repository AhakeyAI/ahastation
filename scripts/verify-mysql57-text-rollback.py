"""Owned portable MySQL5.7 only: nonempty full-text rows survive operator rollback verification."""
import argparse,base64,hashlib,json,re,sys,uuid
from pathlib import Path
import pymysql
from pymysql.constants import CLIENT
ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--fixture',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();file=a.fixture.resolve()
if not file.is_relative_to(ROOT/'runtime'):raise SystemExit('Only an owned runtime fixture is accepted')
config=json.loads(file.read_text(encoding='utf-8'))
assert config['fixture']=='owned-local-mysql' and config['host']=='127.0.0.1'
conn=pymysql.connect(host='127.0.0.1',port=config['port'],user=config['user'],password=config['password'],database='station_hub',charset='utf8mb4',autocommit=True,client_flag=CLIENT.MULTI_STATEMENTS)
sha=lambda b:hashlib.sha256(b).hexdigest()
try:
 with conn.cursor() as c:
  c.execute('SELECT @@datadir,VERSION()');directory,version=c.fetchone();assert Path(directory).resolve()==file.parent/'data';assert version.startswith('5.7.');c.execute('SELECT version FROM hub_schema WHERE id=1');assert c.fetchone()[0]==2
  def old_rows():
   c.execute('SHOW TABLES');names=[row[0] for row in c.fetchall() if row[0] not in ('collab_text_artifacts','collab_text_chunks')];result={}
   for name in names:
    assert re.fullmatch('[A-Za-z0-9_]+',name);c.execute('SELECT * FROM `'+name+'`');rows=sorted(json.dumps(list(row),sort_keys=True,default=lambda x:base64.b64encode(x).decode() if isinstance(x,(bytes,bytearray)) else str(x)) for row in c.fetchall());result[name]=sha('\n'.join(rows).encode())
   return result
  before=old_rows();owner,artifact,task,attempt,device=[str(uuid.uuid4()) for _ in range(5)];data=('保留完整字节🧭e\u0301\n'*1000+'ROLLBACK-RETAINED').encode();digest=sha(data);manifest={'version':1,'artifactId':artifact,'taskId':task,'attemptId':attempt,'mediaType':'text/plain;charset=utf-8','byteLength':len(data),'sha256':digest,'chunkSize':32768,'chunkCount':1,'contentComplete':True,'status':'complete'}
  assert len(data)<=32768
  c.execute('INSERT INTO collab_text_artifacts(owner,id,task_id,attempt_id,device_id,byte_length,data) VALUES(%s,%s,%s,%s,%s,%s,%s)',(owner,artifact,task,attempt,device,len(data),json.dumps(manifest)))
  c.execute('INSERT INTO collab_text_chunks(owner,artifact_id,part,sha256,data) VALUES(%s,%s,0,%s,%s)',(owner,artifact,digest,data))
  sql_hashes={}
  for name in ['06-rollback-text-artifacts.sql','04-add-text-artifacts.sql','05-verify-text-artifacts.sql','06-rollback-text-artifacts.sql']:
   sql=(ROOT/'services/remote/deploy/mysql57-upgrade'/name).read_bytes();sql_hashes[name]=sha(sql);c.execute(sql.decode('utf-8'))
   while c.nextset():pass
  c.execute('SELECT data,byte_length FROM collab_text_artifacts WHERE owner=%s AND id=%s',(owner,artifact));saved,length=c.fetchone();assert json.loads(saved)==manifest and length==len(data)
  c.execute('SELECT data,sha256 FROM collab_text_chunks WHERE owner=%s AND artifact_id=%s AND part=0',(owner,artifact));actual,proof=c.fetchone();assert bytes(actual)==data and proof==sha(actual)==digest
  assert before==old_rows()
  report={'pass':True,'scope':'Owned storage fixture in isolated portable MySQL; additive/rollback SQL preserves nonempty byte rows and legacy tables. No production or workflow authorization claim.','mysqlVersion':version,'byteLength':len(data),'sha256':digest,'nonemptyBytesPreserved':True,'legacyTablesUnchanged':True,'legacyTableCount':len(before),'materialsSha256':sql_hashes}
finally:conn.close()
a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report))
