const test = require('node:test');
const assert = require('node:assert/strict');
const { load, socket, UUID, POOL } = require('./helpers/worker.cjs');

async function forward(unavailable = []) {
  const attempts = [];
  const connect = ({ hostname }) => { attempts.push(hostname); return socket(hostname, unavailable.includes(hostname)); };
  const s = load(connect);
  const ws = { readyState: 1, close() { this.readyState = 3; } };
  const request = { fetcher: { connect } };
  const context = await s.反代参数获取(new URL('https://us.naiops.ccwu.cc/?proxyip=203.0.113.1'), UUID);
  const promise = s.forwardataTCP('chatgpt.com', 443, new Uint8Array([1]), ws, null, {}, UUID, request, context, false, null, true);
  return { promise, attempts, ws };
}
test('standard Cloudflare connect API works without request.fetcher', () => {
  const calls = []; const connect = (...args) => calls.push(args);
  const s = load(connect);
  s.创建请求TCP连接器({})({ hostname: '3.132.174.45', port: 443 });
  assert.equal(calls.length, 1);
});
test('unset ADMIN disables protocol endpoints before UUID derivation', async () => {
  const s = load();
  s.fetch = async () => { throw new Error('must reject locally'); };
  for (const headers of [new Headers({ Upgrade: 'websocket' }), new Headers({ 'content-type': 'application/octet-stream' })]) {
    const response = await s.worker.fetch({ url: 'https://us.naiops.ccwu.cc/', method: 'POST', headers, cf: { colo: 'SJC' } }, {}, {});
    assert.equal(response.status, 503);
  }
});
test('readiness reports bindings and revision without exposing credentials', async () => {
  const s = load();
  const request = { url: 'https://us.naiops.ccwu.cc/healthz', headers: new Headers() };
  const missing = await s.worker.fetch(request, { ADMIN: 'test-secret' }, {});
  assert.equal(missing.status, 503);
  const ready = await s.worker.fetch(request, { ADMIN: 'test-secret', KV: {} }, {});
  assert.equal(ready.status, 200);
  const data = await ready.json();
  assert.deepEqual(data, { status: 'ready', revision: '__NAIOPS_RELEASE_SHA__' });
  assert.equal(JSON.stringify(data).includes('test-secret'), false);
});
test('UUID or subscription KEY does not replace the required ADMIN secret', async () => {
  const s = load();
  s.处理WS请求 = async () => new Response('protocol endpoint reached', { status: 200 });
  for (const env of [{ UUID }, { KEY: 'subscription-key-only' }]) {
    const response = await s.worker.fetch({ url: 'https://us.naiops.ccwu.cc/', method: 'POST',
      headers: new Headers({ Upgrade: 'websocket' }), cf: { colo: 'SJC' } }, env, {});
    assert.equal(response.status, 503);
  }
});
test('environment concurrency cannot race the backup against the primary', async () => {
  const attempts = [];
  const s = load(({ hostname }) => { attempts.push(hostname); return socket(hostname, false); });
  await s.worker.fetch({ url: 'https://us.naiops.ccwu.cc/version', method: 'GET',
    headers: new Headers(), cf: { colo: 'SJC' } }, { ADMIN: 'unit-test-only', PROXY_CONCURRENT_DIAL: '8' }, {});
  const context = await s.反代参数获取(new URL('https://us.naiops.ccwu.cc/'), UUID);
  const result = await s.forwardataTCP('chatgpt.com', 443, new Uint8Array([1]),
    { readyState: 1, close() {} }, null, {}, UUID, {}, context, false, null, true);
  assert.equal(result.hostname, POOL[0]);
  assert.deepEqual(attempts, [POOL[0]]);
});
async function subscribe(target, protocol, addressList = 'us.naiops.ccwu.cc:443#美国入口') {
  const s = load(); const external = [];
  s.fetch = async url => { external.push(url); throw new Error('external request forbidden'); };
  const store = new Map([['ADD.txt', addressList]]);
  const env = { ADMIN: 'unit-test-only', UUID, OFF_LOG: 'true', KV: {
    get: async key => store.get(key) || null, put: async (key, value) => store.set(key, value) } };
  const token = await s.MD5MD5('us.naiops.ccwu.cc' + UUID);
  const response = await s.worker.fetch({ url: `https://us.naiops.ccwu.cc/sub?token=${token}&target=${target}&protocol=${protocol}`,
    method: 'GET', headers: new Headers({ 'User-Agent': 'v2raya' }), cf: { colo: 'SJC', asn: 16509 } }, env, { waitUntil() {} });
  return { response, external };
}
test('actual authenticated Clash subscription uses no third party conversion', async () => {
  const { response, external } = await subscribe('clash', 'vless');
  assert.equal(response.status, 200); const config = JSON.parse(await response.text());
  assert.equal(config.proxies[0].uuid, UUID); assert.deepEqual(external, []);
});
test('SS mixed subscription contains the real password inside SIP002 userinfo', async () => {
  const { response } = await subscribe('mixed', 'ss');
  assert.equal(response.status, 200);
  const links = atob(await response.text()); const link = links.split('\n').find(l => l.startsWith('ss://'));
  assert.ok(link, 'SS subscription is present');
  const encoded = link.slice(5).split('@')[0];
  assert.equal(atob(encoded), 'aes-128-gcm:' + UUID);
});
test('mixed subscription excludes unverified imported nodes from KV', async () => {
  const { response, external } = await subscribe('mixed', 'vless',
    `us.naiops.ccwu.cc:443#美国入口\nvless://${UUID}@non-us.invalid:443?security=tls#external`);
  const links = atob(await response.text()).split('\n');
  assert.equal(links.length, 1);
  assert.equal(new URL(links[0]).hostname, 'us.naiops.ccwu.cc');
  assert.deepEqual(external, []);
});
test('unsupported subscription formats do not call an external converter', async () => {
  const { response, external } = await subscribe('singbox', 'vless');
  assert.equal(response.status, 400);
  assert.deepEqual(external, []);
});
test('URL cannot override the pinned US exits or enable direct fallback', async () => {
  const s = load();
  const c = await s.反代参数获取(new URL('https://us.naiops.ccwu.cc/?proxyip=203.0.113.1&socks5=203.0.113.2:1080'), UUID);
  assert.equal(c.代理类型, 'proxyip'); assert.equal(c.代理全局, true); assert.equal(c.反代兜底, false);
  const addresses = await s.解析地址端口(c.反代IP, 'chatgpt.com', UUID);
  assert.deepEqual(Array.from(addresses, a => a[0]), POOL);
});
test('same primary is used for ChatGPT and its login domains', async () => {
  const s = load(); const pool = POOL.join(',');
  for (const domain of ['chatgpt.com', 'auth.openai.com', 'oaistatic.com']) {
    const addresses = await s.解析地址端口(pool, domain, UUID);
    assert.deepEqual(Array.from(addresses, a => a[0]), POOL);
  }
});
test('TCP goes to the US primary even when direct target is reachable', async () => {
  const { promise, attempts } = await forward();
  const result = await promise;
  assert.equal(result.hostname, POOL[0]); assert.deepEqual(attempts, [POOL[0]]);
});
test('failed primary tries only the US backup', async () => {
  const { promise, attempts } = await forward([POOL[0]]);
  const result = await promise;
  assert.equal(result.hostname, POOL[1]); assert.deepEqual(attempts, POOL);
});
test('all US exits unavailable fails closed without connecting direct', async () => {
  const { promise, attempts, ws } = await forward(POOL);
  await assert.rejects(promise, /所有反代连接失败/);
  assert.deepEqual(attempts, POOL); assert.equal(ws.readyState, 3);
});
test('health checks do not receive a synthetic successful response', async () => {
  const s = load(); const c = await s.反代参数获取(new URL('https://us.naiops.ccwu.cc/'), UUID);
  assert.notEqual(c.代理类型, null);
});
test('native Clash contains TLS VLESS and SS and a real fallback group', () => {
  const s = load(); const config = { HOST: 'us.naiops.ccwu.cc', UUID, SS: { 加密方式: 'aes-128-gcm', TLS: true } };
  const cfg = JSON.parse(s.生成区域Clash订阅(config));
  assert.ok(cfg.proxies.some(p => p.type === 'vless' && p.tls === true));
  assert.ok(cfg.proxies.some(p => p.type === 'ss' && p['plugin-opts'].tls === true));
  assert.ok(cfg['proxy-groups'].some(g => g.type === 'fallback'));
  assert.ok(cfg.proxies.every(p => p.server === 'us.naiops.ccwu.cc'));
  assert.ok(cfg['proxy-groups'].every(g => !g.proxies.includes('DIRECT')));
  assert.deepEqual(cfg.rules, ['MATCH,地区选择']);
});
test('fallback health probe uses a target reachable through the pinned exits', () => {
  const s = load();
  const cfg = JSON.parse(s.生成区域Clash订阅({ HOST: 'us.naiops.ccwu.cc', UUID }));
  const fallback = cfg['proxy-groups'].find(group => group.type === 'fallback');
  assert.equal(fallback.url, 'https://www.cloudflare.com/cdn-cgi/trace');
  assert.equal(fallback['expected-status'], 200);
});
