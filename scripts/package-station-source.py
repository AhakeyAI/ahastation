"""Export current tracked and required untracked source, without local state."""
import argparse,hashlib,json,stat,subprocess,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
output=args.output.resolve();output.mkdir(parents=True,exist_ok=True)
archive=output/'ahastation-collaboration-source.zip'
if archive.exists():raise SystemExit('Output already exists; choose a new candidate directory')
folders={'.github','build','cliicon','contracts','docs','electron','public','resources','scripts','services','src','tests'}
root_files={'AGENTS.md','CLAUDE.md','GLOSSARY.md','README.md','LICENSE','LICENSE.md','Start-AhaStation.cmd','package.json','package-lock.json','electron-builder.json','vite.config.ts','tsconfig.json','tsconfig.electron.json','index.html','.gitignore','.npmrc','.npmrc.example'}
blocked={'node_modules','.venv','__pycache__','.git','runtime','release','dist','dist-electron','station-native','station-native-work'}
paths=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=ROOT).decode('utf-8').split('\0')
tracked=set(subprocess.check_output(['git','ls-files','-z'],cwd=ROOT).decode('utf-8').split('\0'))
deleted=set(subprocess.check_output(['git','ls-files','--deleted','-z'],cwd=ROOT).decode('utf-8').split('\0'))
hashes={}
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as stream:
    def put(name,data):
        entry=zipfile.ZipInfo(name);entry.create_system=3;entry.external_attr=(stat.S_IFREG|0o644)<<16;entry.compress_type=zipfile.ZIP_DEFLATED
        stream.writestr(entry,data)
    for name in sorted(set(p for p in paths if p)):
        if name in deleted or name.startswith('docs/collaboration/evidence/') or name.startswith('docs/collaboration/ROOT_CAUSE_'):continue
        parts=Path(name).parts
        if (len(parts)==1 and name not in root_files) or (len(parts)>1 and parts[0] not in folders):continue
        if (name != 'contracts/runtime/codex.json' and any(p in blocked for p in parts)) or (name.startswith('services/') and not name.startswith('services/remote/')):continue
        source=ROOT/name
        if source.name=='.env' or source.name.startswith('.env.') and not source.name.endswith('.example'):continue
        if source.suffix.lower() in {'.pyc','.db','.sqlite','.exe','.dll'} or source.name.startswith('private-'):continue
        # Versioned static log fixtures are executable test inputs, not runtime
        # profiles. Never include arbitrary/untracked logs or application state.
        if source.suffix.lower()=='.log' and not (name.startswith('tests/fixtures/') and name in tracked):continue
        if source.is_symlink() or not source.is_file():raise SystemExit('Non-regular source entry: '+name)
        data=source.read_bytes();put(name,data);hashes[name]=hashlib.sha256(data).hexdigest()
    for built_manifest in (ROOT/'dist-electron/STATION-SOURCE-MANIFEST.json',ROOT/'build/station-native/SOURCE-MANIFEST.json'):
        if built_manifest.exists():
            for name,digest in json.loads(built_manifest.read_text(encoding='utf-8'))['files'].items():
                assert hashes.get(name)==digest,'Built source missing or stale in export: '+name
    manifest={'format':2,'dirty':bool(subprocess.check_output(['git','status','--porcelain'],cwd=ROOT)),'sourceDigest':hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest(),'dependencyLockSha256':hashes['package-lock.json'],'scope':'Current working-tree sources including untracked implementation; no Git commit or push is implied',
        'branch':subprocess.check_output(['git','branch','--show-current'],cwd=ROOT,text=True).strip(),
        'baseCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'files':hashes}
    put('CANDIDATE-SOURCE-MANIFEST.json',json.dumps(manifest,indent=2).encode('utf-8'))
with zipfile.ZipFile(archive) as stream:
    assert all(hashlib.sha256(stream.read(name)).hexdigest()==digest for name,digest in hashes.items())
    assert all((stream.getinfo(name).external_attr>>16)&0o777==0o644 for name in hashes)
print(json.dumps({'archive':str(archive),'files':len(hashes),'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'manifestVerified':True}))
