// Loaded in the test process and inherited by Node fixture children.
// Unit tests may replace fetch with an in-memory fake; real sockets stay local.
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import {syncBuiltinESMExports} from 'node:module';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';

function local(host) {
  return host === undefined || host === '' || host === 'localhost'
    || host === '::1' || host === '[::1]' || host === '0:0:0:0:0:0:0:1'
    || /^127(?:\.\d{1,3}){3}$/.test(String(host));
}

function assertLocal(host) {
  if (!local(host)) throw new Error(`Offline test refused non-loopback connection: ${host}`);
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // Node also passes a normalized [options, callback] pair internally.
  const value = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (value && typeof value === 'object') {
    if (!value.path) assertLocal(value.host);
  } else if (typeof value === 'number') {
    assertLocal(typeof args[1] === 'string' ? args[1] : undefined);
  }
  return connect.apply(this, args);
};

const lookup = dns.lookup;
dns.lookup = function (host, ...args) {
  assertLocal(host);
  return lookup.call(this, host, ...args);
};
const lookupPromise = dns.promises.lookup;
dns.promises.lookup = async function (host, ...args) {
  assertLocal(host);
  return lookupPromise.call(this, host, ...args);
};
// Resolver APIs bypass lookup() and can send UDP to the system DNS server.
const rejectResolver = () => { throw new Error('Offline test refused DNS resolver query'); };
for (const api of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const name of Object.getOwnPropertyNames(api)) {
    if ((name.startsWith('resolve') || name === 'reverse') && typeof api[name] === 'function') api[name] = rejectResolver;
  }
}
const datagramConnect = dgram.Socket.prototype.connect;
dgram.Socket.prototype.connect = function (port, address, ...args) {
  assertLocal(typeof address === 'string' ? address : undefined);
  return datagramConnect.call(this, port, address, ...args);
};
const datagramSend = dgram.Socket.prototype.send;
dgram.Socket.prototype.send = function (...args) {
  const address = typeof args[2] === 'number' ? args[4] : args[2];
  assertLocal(typeof address === 'string' ? address : undefined);
  return datagramSend.apply(this, args);
};
const request = globalThis.fetch;
globalThis.fetch = function (input, options) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assertLocal(url.hostname);
  return request(input, options);
};
syncBuiltinESMExports();

if (process.env.AHASTATION_OFFLINE_TEST_ROOT) {
  const profile = join(process.env.AHASTATION_OFFLINE_TEST_ROOT, `node-${process.pid}`);
  mkdirSync(profile, {recursive: true});
  process.env.AHASTATION_TEST_PROFILE = profile;
}
