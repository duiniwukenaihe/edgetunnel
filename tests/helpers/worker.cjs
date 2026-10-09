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
    setTimeout, clearTimeout, atob, btoa, connect, WebSocket: { OPEN: 1, CLOSING: 2, CLOSED: 3 } };
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

module.exports = { load, socket, UUID, POOL };
