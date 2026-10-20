import asyncio
import importlib.util
import json
import os
import socket
import sys
import tempfile
import unittest
import zipfile
import hashlib
import stat
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'device'))
import httpx
import uvicorn
import websockets
ROOT=Path(__file__).resolve().parents[1]
class ProbeTest(unittest.IsolatedAsyncioTestCase):
    async def test_actual_http_header_ws_idle_and_heartbeat(self):
        spec=importlib.util.spec_from_file_location('disposable_probe',ROOT/'probe'/'app.py'); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        listener=socket.socket(); listener.bind(('127.0.0.1',0)); url=f'http://127.0.0.1:{listener.getsockname()[1]}'
        server=uvicorn.Server(uvicorn.Config(module.app,log_level='critical',lifespan='off')); task=asyncio.create_task(server.serve(sockets=[listener]))
        token='disposable-probe-test-no-real-credential'
        try:
            with patch.dict(os.environ,{'PROBE_TOKEN':token}):
                while not server.started: await asyncio.sleep(.01)
                async with httpx.AsyncClient(trust_env=False) as http:
                    response=await http.get(url+'/health'); self.assertTrue(response.json()['probe'])
                with self.assertRaises(websockets.exceptions.InvalidStatus):
                    async with websockets.connect(url.replace('http:','ws:')+'/probe/socket'): pass
                async with websockets.connect(url.replace('http:','ws:')+'/probe/socket',additional_headers={'Authorization':'Bearer '+token},ping_interval=None) as ws:
                    welcome=json.loads(await ws.recv()); self.assertTrue(welcome['authorization_header_present']); self.assertEqual(welcome['path'],'/probe/socket')
                    await asyncio.sleep(.1); await ws.send(json.dumps({'type':'heartbeat','sequence':7}))
                    response=json.loads(await ws.recv()); self.assertEqual(response['sequence'],7); self.assertEqual(response['boot_id'],welcome['boot_id'])
        finally: server.should_exit=True; await task; listener.close()

class PackageTest(unittest.TestCase):
    def test_source_zip_unix_permissions_and_compression(self):
        import subprocess
        with tempfile.TemporaryDirectory(prefix='hub-permissions-') as directory:
            subprocess.run([sys.executable,str(ROOT/'scripts'/'package_hub.py'),'--output',directory],check=True,capture_output=True)
            archives=list(Path(directory).glob('*.zip'))
            self.assertEqual(len(archives),2)  # Shared Hub and WSS exporter.
            for archive in archives:
                with zipfile.ZipFile(archive) as stream:
                    names=stream.namelist()
                    for required in ('Dockerfile','.dockerignore','SOURCE-MANIFEST.json'):
                        self.assertIn(required,names)
                    for entry in stream.infolist():
                        with self.subTest(archive=archive.name,entry=entry.filename):
                            self.assertEqual(entry.create_system,3)
                            mode=entry.external_attr >> 16
                            self.assertEqual(stat.S_IMODE(mode),0o755 if entry.is_dir() else 0o644)
                            self.assertEqual(stat.S_IFMT(mode),stat.S_IFDIR if entry.is_dir() else stat.S_IFREG)
                            self.assertEqual(entry.compress_type,zipfile.ZIP_DEFLATED)

    def test_working_tree_allowlist_and_checksums(self):
        import subprocess
        with tempfile.TemporaryDirectory(prefix='hub-export-') as directory:
            subprocess.run([sys.executable,str(ROOT/'scripts'/'package_hub.py'),'--output',directory],check=True,capture_output=True)
            for archive in Path(directory).glob('*.zip'):
                with zipfile.ZipFile(archive) as stream:
                    names=stream.namelist(); self.assertIn('Dockerfile',names)
                    self.assertFalse(any(any(part in name.split('/') for part in ('.git','.venv','node_modules','runtime')) for name in names))
                    self.assertFalse(any(name.endswith('.env') or name.startswith('.env') for name in names))
                    manifest=json.loads(stream.read('SOURCE-MANIFEST.json'))['files']
                    for name,digest in manifest.items(): self.assertEqual(hashlib.sha256(stream.read(name)).hexdigest(),digest)
                    if 'device/public_hub.py' in names:
                        self.assertEqual(stream.read('device/public_hub.py'),(ROOT/'device'/'public_hub.py').read_bytes())
                        self.assertEqual(stream.read('Dockerfile'),(ROOT/'deploy'/'Dockerfile').read_bytes())
                    else: self.assertEqual(stream.read('Dockerfile'),(ROOT/'probe'/'Dockerfile').read_bytes())
                    self.assertNotIn('device/desktop_agent.py',names)  # No projects/local Bridge state in cloud export.
if __name__=='__main__': unittest.main()
