"""Restart the real isolated fixture repeatedly on its original loopback port."""
import asyncio
import json
import sys
import unittest
from pathlib import Path
import httpx


class HubFixtureRestartTest(unittest.IsolatedAsyncioTestCase):
    async def test_repeated_restart_preserves_endpoint_and_durable_account(self):
        fixture = Path(__file__).with_name('station_collaboration_fixture.py')
        process = await asyncio.create_subprocess_exec(sys.executable, str(fixture), stdin=asyncio.subprocess.PIPE,
                                                       stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        errors = asyncio.create_task(process.stderr.read())
        try:
            ready = json.loads(await asyncio.wait_for(process.stdout.readline(), 30))
            self.assertTrue(ready['ready'])
            async with httpx.AsyncClient(base_url=ready['url'], trust_env=False, timeout=10) as http:
                for _ in range(3):
                    self.assertEqual((await http.get('/health')).status_code, 200)
                    process.stdin.write(b'restart\n')
                    await process.stdin.drain()
                    restarted = json.loads(await asyncio.wait_for(process.stdout.readline(), 30))
                    self.assertTrue(restarted['restarted'])
                    user = await http.get('/v2/me', headers={'Authorization': 'Bearer ' + ready['token']})
                    self.assertEqual(user.status_code, 200)
                    self.assertEqual(user.json()['owner_id'], ready['owner'])
        finally:
            process.stdin.close()
            try:
                await asyncio.wait_for(process.wait(), 30)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
            diagnostics = (await errors).decode('utf-8', errors='replace')
        self.assertEqual(process.returncode, 0, diagnostics[-4000:])
