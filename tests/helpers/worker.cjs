const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const { webcrypto, createHash } = require('node:crypto');

const SOURCE = process.env.NAIOPS_SOURCE || resolve(__dirname, '../../_worker.js');
const UUID = 'd68a14d0-1429-4da6-b994-1abceba01234';
const POOL = ['3.132.174.45', '192.3.208.192'];
function load(connect = () => { throw new Error('unexpected TCP'); }) {
  const sandbox = { console, URL, URLSearchParams, Headers, Response, Request, TextEncoder, TextDecoder,
    crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto), subtle: new Proxy(webcrypto.subtle, {
      get(target, name) { if (name === 'digest') return (algorithm, data) => algorithm === 'MD5'
        ? Promise.resolve(Uint8Array.from(createHash('md5').update(Buffer.from(data)).digest()).buffer)
        : target.digest(algorithm, data); const value = target[name]; return typeof value === 'function' ? value.bind(target) : value; }
    }) }, performance, ReadableStream, WritableStream, TransformStream,
    setTimeout, clearTimeout, AbortController, AbortSignal, atob, btoa, connect, WebSocket: { OPEN: 1, CLOSING: 2, CLOSED: 3 } };
  vm.createContext(sandbox);
  const source = readFileSync(SOURCE, 'utf8').replace(/^\s*import \{ connect \} from ['"]cloudflare:sockets['"];?\s*/m, '')
    .replace('export default {', 'const worker = {');
  vm.runInContext(source + '\n globalThis.worker = worker;', sandbox);
  return sandbox;
}
function socket(hostname, unavailable) {
  return { hostname, opened: unavailable ? Promise.reject(new Error('offline')) : Promise.resolve({}),
    closed: Promise.resolve(), close() {}, writable: new WritableStream({ write() {} }) };
}

// Explicit fixture cache for routing tests; network verification has separate native-TLS tests.
async function seedVerifiedPool(s, env, config, request) {
  for (const region of config.regions) {
    const now = Date.now();
    const pool = {version:1,region:region.code,exits:region.exits.map(address => ({address,
      exitIP:address.slice(0,-4).replace(/^\[|\]$/g,''),country:region.code,checkedAt:now,latency:5,tlsNameVerified:true})),
      failures:[],cursor:0,lastAttemptAt:now,nextRefreshAt:now+900000,expiresAt:now+1800000};
    await env.KV.put(await s.区域池缓存键(region, request), JSON.stringify(pool));
  }
}

module.exports = { load, socket, UUID, POOL, seedVerifiedPool };
