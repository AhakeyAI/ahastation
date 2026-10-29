"""Real loopback HTTP through Uvicorn's configured proxy boundary; no external services."""
import asyncio
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'device'))
import httpx
import uvicorn
from sqlalchemy import create_engine
from hub_store import HubStore
from public_hub import create_app, trusted_proxy_ips


class ProxyConfigurationTest(unittest.TestCase):
    def test_proxy_trust_is_explicit_and_rejects_wildcards(self):
        with patch.dict(os.environ, {'HUB_TRUSTED_PROXY_IPS': '', 'FORWARDED_ALLOW_IPS': '*'}):
            self.assertEqual(trusted_proxy_ips(), [])
        with patch.dict(os.environ, {'HUB_TRUSTED_PROXY_IPS': '127.0.0.1, 10.1.0.0/24, ::1'}):
            self.assertEqual(trusted_proxy_ips(), ['127.0.0.1/32', '10.1.0.0/24', '::1/128'])
        for value in ('*', 'localhost', '10.0.0.0/8,*', '0.0.0.0/0', '::/0'):
            with self.subTest(value=value), patch.dict(os.environ, {'HUB_TRUSTED_PROXY_IPS': value}):
                with self.assertRaises(RuntimeError):
                    trusted_proxy_ips()


class ProxyRequestTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='hub-proxy-trust-')
        self.engine = create_engine('sqlite:///' + str(Path(self.temp.name) / 'hub.sqlite'))
        self.store = HubStore(self.engine, 'proxy-test-only-secret-at-least-32-characters')
        self.store.migrate()
        self.keys = []
        original_rate = self.store.rate

        def record_rate(key, *args, **kwargs):
            self.keys.append(key)
            return original_rate(key, *args, **kwargs)

        self.store.rate = record_rate
        self.server = None
        self.http = None

    async def start(self, proxies):
        self.socket = socket.socket()
        self.socket.bind(('127.0.0.1', 0))
        with patch.dict(os.environ, {'HUB_TRUSTED_PROXY_IPS': proxies, 'FORWARDED_ALLOW_IPS': '*'}):
            config = uvicorn.Config(create_app(self.store), log_level='critical', proxy_headers=True,
                                    forwarded_allow_ips=trusted_proxy_ips())
        self.server = uvicorn.Server(config)
        self.serving = asyncio.create_task(self.server.serve(sockets=[self.socket]))
        for _ in range(500):
            if self.server.started:
                break
            await asyncio.sleep(.01)
        self.assertTrue(self.server.started)
        self.http = httpx.AsyncClient(base_url=f'http://127.0.0.1:{self.socket.getsockname()[1]}', trust_env=False)

    async def asyncTearDown(self):
        if self.http:
            await self.http.aclose()
        if self.server:
            self.server.should_exit = True
            await asyncio.wait_for(self.serving, 15)
            self.socket.close()
        self.engine.dispose()
        self.temp.cleanup()

    async def login(self, username, forwarded):
        return await self.http.post('/v2/auth/login', json={'login': username, 'password': 'test-password-123'},
                                    headers={'X-Forwarded-For': forwarded})

    async def test_direct_client_cannot_rotate_forwarded_addresses_to_bypass_ip_limit(self):
        await self.start('')
        for number in range(16):
            response = await self.login(f'nonexistent-{number}', f'198.51.100.{number + 1}')
            self.assertEqual(response.status_code, 401 if number < 15 else 429)
        self.assertEqual({key for key in self.keys if key.startswith('auth-ip:')}, {'auth-ip:127.0.0.1'})
        response = await self.http.post('/v2/pairings/claim', json={'projects_confirmed': True, 'pair_code': 'x' * 24},
                                        headers={'X-Forwarded-For': '203.0.113.42'})
        self.assertEqual(response.status_code, 400)
        self.assertIn('claim:127.0.0.1', self.keys)

    async def test_configured_proxy_preserves_individual_clients_and_uses_rightmost_untrusted_hop(self):
        await self.start('127.0.0.1')
        for number in range(16):
            response = await self.login(f'proxied-{number}', f'198.51.100.{number + 1}')
            self.assertEqual(response.status_code, 401)
        self.assertEqual(len({key for key in self.keys if key.startswith('auth-ip:')}), 16)
        response = await self.login('chain-client', '192.0.2.6, 198.51.100.90, 127.0.0.1')
        self.assertEqual(response.status_code, 401)
        self.assertIn('auth-ip:198.51.100.90', self.keys)
        self.assertNotIn('auth-ip:192.0.2.6', self.keys)
        await self.http.post('/v2/pairings/claim', json={'projects_confirmed': True, 'pair_code': 'x' * 24},
                             headers={'X-Forwarded-For': '203.0.113.42'})
        self.assertIn('claim:203.0.113.42', self.keys)
