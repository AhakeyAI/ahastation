"""Opt-in native Desktop handshake probe; never touches existing GUI sessions.

Starts a separate Desktop profile and a capability-protected loopback proxy.
No thread is resumed or model turn sent. This is NOT execution acceptance.
"""
import asyncio
import json
import os
import secrets
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'device'))


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


async def probe(directory, desktop, binary):
    from websockets.asyncio.client import connect
    from websockets.asyncio.server import serve
    from task_process import WindowsJob
    from codex_shared_service import Gateway
    from codex_shared import save_endpoint,private_file
    directory.mkdir(parents=True, exist_ok=True)
    os.environ['POCKET_VIBE_STATE_DIR']=str(directory/'bridge-state')
    token = secrets.token_urlsafe(32)
    token_file = directory / 'native-token'
    private_file(token_file,token)
    native_port = port()
    endpoint = 'ws://127.0.0.1:' + str(native_port)
    env = {**os.environ, 'CODEX_SQLITE_HOME': str(directory / 'sqlite')}
    job = WindowsJob() if os.name == 'nt' else None
    processes = []
    def spawn(command, **options):
        process = (job.spawn if job else subprocess.Popen)(command, **options,
            creationflags=4 if job else 0, start_new_session=not bool(job))
        processes.append(process)
        if job: job.attach_and_resume(process)
        return process
    record = {'desktop': desktop, 'runtime': binary, 'desktop_initializations': [],
              'native_pid': None, 'desktop_pid': None, 'native_messages': []}
    def save():
        (directory / 'handshake.json').write_text(json.dumps(record, indent=2), encoding='utf-8')
    try:
        log = (directory / 'native.log').open('w', encoding='utf-8')
        native = spawn([binary, '-c', 'features.code_mode_host=true', 'app-server', '--listen', endpoint,
                        '--ws-auth', 'capability-token', '--ws-token-file', str(token_file)],
                       env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        record['native_pid'] = native.pid
        for _ in range(100):
            try:
                async with connect(endpoint, additional_headers={'Authorization': 'Bearer ' + token}): break
            except Exception:
                if native.poll() is not None: raise RuntimeError('Native app-server stopped; inspect native.log')
                await asyncio.sleep(.1)
        gate_token = secrets.token_urlsafe(32)
        gateway=Gateway(endpoint,token,gate_token,str(__import__('uuid').uuid4()))
        async with serve(gateway.handler, '127.0.0.1', 0) as server:
            desktop_env = {**env, 'CODEX_APP_SERVER_WS_URL': 'ws://127.0.0.1:' + str(server.sockets[0].getsockname()[1]) + '/' + gate_token,
                'CODEX_ELECTRON_USER_DATA_PATH': str(directory / 'desktop-profile')}
            endpoint_file=directory/'local-endpoint.json'
            endpoint_file.write_text(json.dumps({'url':desktop_env['CODEX_APP_SERVER_WS_URL']}),encoding='utf-8')
            endpoint_file.chmod(0o600)
            save_endpoint(directory/'bridge-state'/'remote'/'codex-shared',{
                'url':desktop_env['CODEX_APP_SERVER_WS_URL'],'generation':gateway.generation})
            desktop_log = (directory / 'desktop.log').open('w', encoding='utf-8')
            app = spawn([desktop, '--user-data-dir=' + str(directory / 'desktop-profile')], env=desktop_env,
                        stdin=subprocess.DEVNULL, stdout=desktop_log, stderr=desktop_log)
            record['desktop_pid'] = app.pid
            save()
            print(json.dumps({'probe': str(directory), 'native_pid': native.pid, 'desktop_pid': app.pid}), flush=True)
            # Stop file allows cleanup of ONLY the processes atomically created
            # in this probe's Job. The user's existing Desktop isn't a member.
            while not (directory / 'stop').exists() and native.poll() is None and app.poll() is None:
                record['shared_gateway_desktop_connected']=bool(gateway.desktop_peers)
                record['desktop_initializations']=[value.get('client_info') for value in gateway.desktop_connections.values()]
                save()
                await asyncio.sleep(.25)
            record['desktop_exit_code'] = app.poll()
    finally:
        if job: job.close()
        else:
            for process in reversed(processes):
                if process.poll() is None: process.terminate()
        for process in processes:
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: record['cleanup_unconfirmed'] = True
        token_file.unlink(missing_ok=True)
        (directory/'local-endpoint.json').unlink(missing_ok=True)
        save()


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--desktop', required=True)
    parser.add_argument('--binary', required=True)
    args = parser.parse_args()
    if os.name != 'nt': raise SystemExit('This native isolation probe currently requires Windows; not macOS acceptance')
    asyncio.run(probe(args.directory, args.desktop, args.binary))
