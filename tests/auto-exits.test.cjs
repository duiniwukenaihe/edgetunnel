const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const path = require('node:path');

function fixture() {
  let now = 1800000000000;
  const store = new Map(), probes = [], writes = [];
  const s = { URL, URLSearchParams, Response, Request, TextEncoder, TextDecoder, ReadableStream,
    WritableStream, AbortController, AbortSignal, crypto: webcrypto, performance, setTimeout, clearTimeout,
    Date: class extends Date { static now() { return now; } }, 发布版本: 'fixture-release',
    区域错误: (message, status = 400) => Object.assign(new Error(message), { status }) };
  const file = path.resolve(__dirname, '../policy/auto-exits.js');
  vm.createContext(s); vm.runInContext(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', s);
  const env = { KV: { get: async key => store.get(key) ?? null,
    put: async (key, value) => { writes.push(key); store.set(key, value); } } };
  const request = new Request('https://us.naiops.ccwu.cc/');
  Object.defineProperty(request, 'cf', { value: { colo: 'SJC' } });
  const region = { code: 'US', name: '美国', exits: ['3.132.174.45:443'], auto: false, source: null };
  const nativeProbe = s.探测区域出口;
  s.探测区域出口 = async (address, country) => {
    probes.push(address);
    return { address, exitIP: address.split(':')[0], country, checkedAt: now, latency: 5, tlsNameVerified: true };
  };
  return { s, nativeProbe, env, request, region, store, probes, writes, advance: ms => { now += ms; } };
}

test('only canonical public IPs and port 443 may be discovery candidates', () => {
  const { s } = fixture();
  assert.equal(s.验证公共出口('3.132.174.45:443'), '3.132.174.45:443');
  assert.equal(s.验证公共出口('[2606:4700::1111]:443'), '[2606:4700::1111]:443');
  for (const value of ['127.0.0.1:443', '10.1.2.3:443', '169.254.169.254:443', '192.168.1.1:443',
    '100.64.1.1:443', '198.51.100.1:443', '224.1.1.1:443', '[::1]:443', '[::ffff:7f00:1]:443',
    '[fc00::1]:443', '[fe80::1]:443', '[2001:db8::1]:443', '03.1.2.3:443', 'host.test:443', '3.132.174.45:80'])
    assert.throws(() => s.验证公共出口(value), undefined, value);
});

test('trace requires HTTP 200, public exit address and the selected country', () => {
  const { s } = fixture();
  const good = 'HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\nip=3.132.174.45\nloc=US\n';
  assert.equal(s.解析出口检测响应(good, 'US').country, 'US');
  for (const body of [good.replace('200', '403'), good.replace('US', 'JP'), good.replace('loc=US', ''),
    good.replace('3.132.174.45', '127.0.0.1'), good + 'loc=JP\n'])
    assert.throws(() => s.解析出口检测响应(body, 'US'));
});

test('fresh checked pool is reused without source fetch or extra probes', async () => {
  const f = fixture();
  const first = await f.s.获取有效区域池(f.env, f.region, f.request);
  const second = await f.s.获取有效区域池(f.env, f.region, f.request);
  assert.equal(first.exits[0].country, 'US');
  assert.equal(second.exits[0].address, f.region.exits[0]);
  assert.equal(f.probes.length, 1); assert.equal(f.writes.length, 1);
});

test('expiry rejects old exits when every new check fails, then applies retry backoff', async () => {
  const f = fixture(); await f.s.获取有效区域池(f.env, f.region, f.request);
  f.advance(31 * 60000); let count = 0;
  f.s.探测区域出口 = async () => { count++; throw new Error('offline'); };
  await assert.rejects(f.s.获取有效区域池(f.env, f.region, f.request), /出口/);
  await assert.rejects(f.s.获取有效区域池(f.env, f.region, f.request), /出口/);
  assert.equal(count, 1);
});

test('a forced refresh keeps a healthy primary before a faster new candidate', async () => {
  const f = fixture();
  f.region.auto = true; f.region.source = 'cmliu-us-dns';
  f.s.发现区域候选 = async () => ['3.132.174.45:443'];
  await f.s.获取有效区域池(f.env, f.region, f.request);
  f.advance(61000);
  f.s.发现区域候选 = async () => ['3.132.174.45:443', '192.9.157.76:443'];
  const probe = f.s.探测区域出口;
  f.s.探测区域出口 = async (...args) => ({ ...await probe(...args), latency: args[0].startsWith('192.') ? 1 : 20 });
  const pool = await f.s.获取有效区域池(f.env, f.region, f.request, true);
  assert.equal(pool.exits[0].address, '3.132.174.45:443');
});

test('aborting native TLS stops promptly and never upgrades a late opening socket', async () => {
  const f = fixture(); let open, upgrades = 0;
  f.s.connect = () => ({ opened: new Promise(resolve => { open = resolve; }),
    close: async () => {}, startTls() { upgrades++; throw new Error('late upgrade'); } });
  const controller = new AbortController();
  const probe = f.s.读取验证TLS响应('3.132.174.45:443', 'www.cloudflare.com', controller.signal);
  controller.abort();
  await assert.rejects(Promise.race([probe, new Promise((_, reject) => setTimeout(() => reject(new Error('abort did not stop')), 100))]), /取消/);
  open(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(upgrades, 0);
});

test('refresh bounds candidate probes to four and concurrency to two', async () => {
  const f = fixture(); let active = 0, maximum = 0, count = 0;
  f.s.发现区域候选 = async () => Array.from({length: 32}, (_, i) => `8.8.8.${i + 1}:443`);
  const probe = f.s.探测区域出口;
  f.s.探测区域出口 = async (...args) => { count++; maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--; return probe(...args); };
  await f.s.获取有效区域池(f.env, f.region, f.request);
  assert.equal(count, 4); assert.equal(maximum, 2);
});

test('failed KV reads and writes cannot enable an unpersisted pool', async () => {
  const f = fixture(); f.env.KV.get = async () => { throw new Error('storage outage'); };
  await assert.rejects(f.s.获取有效区域池(f.env, f.region, f.request, true), /读取/);
  assert.equal(f.probes.length, 0);
  const g = fixture(); g.env.KV.put = async () => { throw new Error('storage outage'); };
  await assert.rejects(g.s.获取有效区域池(g.env, g.region, g.request), /保存/);
});

test('failed refresh preserves original expiry and never extends an old verification', async () => {
  const f = fixture(); const first = await f.s.获取有效区域池(f.env, f.region, f.request);
  f.advance(16 * 60000); f.s.探测区域出口 = async () => { throw new Error('offline'); };
  const second = await f.s.获取有效区域池(f.env, f.region, f.request);
  assert.equal(second.expiresAt, first.expiresAt);
  assert.equal(second.exits[0].checkedAt, first.exits[0].checkedAt);
});

test('automatic discovery failure is visible while manual candidates still work', async () => {
  const f = fixture(); f.region.auto = true; f.region.source = 'cmliu-us-dns';
  f.s.fetch = async () => { throw new Error('DNS unavailable'); };
  const pool = await f.s.获取有效区域池(f.env, f.region, f.request);
  assert.equal(pool.exits.length, 1); assert.match(pool.failures[0].reason, /DNS/);
});

test('simultaneous authenticated requests share a refresh for one KV/region/context', async () => {
  const f = fixture(); let release;
  const original = f.s.探测区域出口;
  f.s.探测区域出口 = async (...args) => { await new Promise(resolve => { release = resolve; }); return original(...args); };
  const a = f.s.获取有效区域池(f.env, f.region, f.request);
  const b = f.s.获取有效区域池(f.env, f.region, f.request);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  release(); await Promise.all([a, b]); assert.equal(f.probes.length, 1);
});

test('colo, origin and configuration changes cannot reuse a different verified pool', async () => {
  const f = fixture();
  const one = await f.s.区域池缓存键(f.region, f.request);
  const other = new Request('https://preview.naiops-us-github.pages.dev/');
  Object.defineProperty(other, 'cf', { value: { colo: 'NRT' } });
  assert.notEqual(await f.s.区域池缓存键(f.region, other), one);
  f.region.exits.push('192.9.157.76:443');
  assert.notEqual(await f.s.区域池缓存键(f.region, f.request), one);
});

test('DNS source is fixed, public-only, deduplicated and bounded', async () => {
  const f = fixture(); f.region.auto = true; f.region.source = 'cmliu-us-dns';
  const requests = [];
  f.s.fetch = async url => {
    requests.push(new URL(url));
    return Response.json({ Status: 0, Answer: [
      { type: 1, data: '192.9.157.76' }, { type: 1, data: '127.0.0.1' },
      { type: 1, data: '192.9.157.76' }, { type: 28, data: '2606:4700::1111' }
    ] });
  };
  const results = await f.s.发现区域候选(f.region);
  assert.deepEqual(Array.from(results), ['3.132.174.45:443', '192.9.157.76:443', '[2606:4700::1111]:443']);
  assert.ok(requests.every(url => url.origin === 'https://cloudflare-dns.com' && url.searchParams.get('name') === 'proxyip.us.cmliussss.net'));
});

test('unverified or mismatched country probe results cannot enter a pool', async () => {
  for (const patch of [{ country: 'JP' }, { tlsNameVerified: false }, { checkedAt: 0 }]) {
    const f = fixture(); const original = f.s.探测区域出口;
    f.s.探测区域出口 = async (...args) => ({ ...await original(...args), ...patch });
    await assert.rejects(f.s.获取有效区域池(f.env, f.region, f.request), /出口/);
  }
});

test('TLS probe requires the wrong-hostname connection to be rejected', async () => {
  const f = fixture();
  f.s.探测区域出口 = f.nativeProbe;
  const trace = 'HTTP/1.0 200 OK\r\n\r\nip=3.132.174.45\nloc=US\n';
  f.s.读取验证TLS响应 = async () => trace;
  await assert.rejects(f.s.探测区域出口('3.132.174.45:443', 'US'), /域名|证书/);
});

test('ordinary TLS resets are never treated as certificate-name validation', async () => {
  const f=fixture(); const trace='HTTP/1.0 200 OK\r\n\r\nip=3.132.174.45\nloc=US\n';
  f.s.读取验证TLS响应=async (_,name)=>{if(name==='www.cloudflare.com')return trace;
    throw Object.assign(new Error('connection reset by peer'),{probeStage:'tls'});};
  await assert.rejects(f.nativeProbe('3.132.174.45:443','US'),/证书/);
});

test('explicit TLS certificate hostname refusal permits a correctly checked US exit', async () => {
  const f=fixture();const trace='HTTP/1.0 200 OK\r\n\r\nip=3.132.174.45\nloc=US\n';
  f.s.读取验证TLS响应=async(_,name)=>{if(name==='www.cloudflare.com')return trace;
    throw Object.assign(new Error('Hostname/IP does not match certificate alt names'),{probeStage:'tls',code:'ERR_TLS_CERT_ALTNAME_INVALID'});};
  assert.equal((await f.nativeProbe('3.132.174.45:443','US')).tlsNameVerified,true);
});

test('new evidence of another country immediately removes the old US exit', async () => {
  const f=fixture(); await f.s.获取有效区域池(f.env,f.region,f.request);f.advance(16*60000);
  f.s.探测区域出口=f.nativeProbe;
  f.s.读取验证TLS响应=async()=> 'HTTP/1.0 200 OK\r\n\r\nip=3.132.174.45\nloc=JP\n';
  await assert.rejects(f.s.获取有效区域池(f.env,f.region,f.request),/出口/);
  const {entry}=await f.s.读取出口池状态(f.env,f.region,f.request);
  assert.equal(entry.pool.exits.length,0);
});

test('KV write outage cannot resurrect an exit already found in another country', async () => {
  const f=fixture();await f.s.获取有效区域池(f.env,f.region,f.request);f.advance(16*60000);
  f.s.探测区域出口=f.nativeProbe;f.s.读取验证TLS响应=async()=> 'HTTP/1.0 200 OK\r\n\r\nip=3.132.174.45\nloc=JP\n';
  const put=f.env.KV.put;f.env.KV.put=async()=>{throw new Error('KV write outage');};
  await assert.rejects(f.s.获取有效区域池(f.env,f.region,f.request),/保存/);
  f.env.KV.put=put;f.s.探测区域出口=async()=>{throw new Error('offline');};
  await assert.rejects(f.s.获取有效区域池(f.env,f.region,f.request),/出口/);
});

test('native TLS opened failure is observed and both socket closed rejections handled', async () => {
  const f=fixture();const error=new Error('certificate hostname mismatch');let closedHandled=0;
  const closed={catch(fn){closedHandled++;fn(error);return Promise.resolve();}};
  f.s.connect=()=>({opened:Promise.resolve(),closed,close:async()=>{},startTls:()=>({
    opened:Promise.reject(error),closed,close:async()=>{},writable:new WritableStream({write(){throw error;}}),readable:new ReadableStream()})});
  await assert.rejects(f.s.读取验证TLS响应('3.132.174.45:443'),/certificate/);
  assert.equal(closedHandled,2);
});
