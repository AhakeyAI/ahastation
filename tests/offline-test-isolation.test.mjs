import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('offline preload blocks direct sockets, DNS and fetch before external I/O', () => {
  const source = `
    import assert from 'node:assert/strict';
    import net from 'node:net';
    import dns from 'node:dns';
    import dgram from 'node:dgram';
    assert.throws(()=>net.connect({host:'203.0.113.1',port:443}),/refused non-loopback/);
    assert.throws(()=>dns.lookup('outside.invalid',()=>{}),/refused non-loopback/);
    await assert.rejects(dns.promises.lookup('outside.invalid'),/refused non-loopback/);
    assert.throws(()=>dns.resolve4('outside.invalid',()=>{}),/refused DNS resolver/);
    assert.throws(()=>new dns.Resolver().resolve4('outside.invalid',()=>{}),/refused DNS resolver/);
    const udp=dgram.createSocket('udp4');
    assert.throws(()=>udp.send(Buffer.from('blocked'),53,'203.0.113.1'),/refused non-loopback/);
    udp.close();
    assert.throws(()=>fetch('https://outside.invalid'),/refused non-loopback/);
    const server=net.createServer(socket=>socket.end('local fixture'));
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const socket=net.connect(server.address().port,'127.0.0.1');
    let data='';for await(const bytes of socket)data+=bytes;
    assert.equal(data,'local fixture');
    await new Promise(resolve=>server.close(resolve));
  `;
  const result = spawnSync(process.execPath, ['--import', './tests/offline-network.mjs', '--input-type=module', '-e', source], {encoding: 'utf8', windowsHide: true});
  assert.equal(result.status, 0, result.stderr);
});
