const test = require('node:test');
const assert = require('node:assert/strict');
const { load, socket, UUID, POOL, seedVerifiedPool } = require('./helpers/worker.cjs');
const ORIGIN = 'https://us.naiops.ccwu.cc';
const regions = () => ({ version: 1, defaultRegion: 'US', regions: [
  { code: 'US', name: '美国', exits: POOL.map(ip => ip + ':443') },
  { code: 'JP', name: '日本', exits: ['8.8.8.8:443', '9.9.9.9:443'] }
] });
function storage(config) {
  const store = new Map(config === undefined ? [] : [['regions.json', JSON.stringify(config)]]);
  return { store, env: { ADMIN: 'test-only-password', UUID, HOST: 'us.naiops.ccwu.cc', OFF_LOG: 'true',
    KV: { get: async key => store.get(key) ?? null, put: async (key, value) => store.set(key, value) } } };
}
async function session(config) {
  const s = load(); const { store, env } = storage(config); let cookie = '';
  s.fetch = async () => new Response('legacy settings');
  async function request(path, options = {}, authenticated = true) {
    const req = new Request(ORIGIN + path, { ...options, headers: { 'User-Agent': 'region-test',
      ...(authenticated && cookie ? { Cookie: cookie } : {}), ...options.headers } });
    Object.defineProperty(req, 'cf', { value: { colo: 'SJC', asn: 16509 } });
    return s.worker.fetch(req, env, { waitUntil() {} });
  }
  const login = await request('/login', { method: 'POST', body: 'password=test-only-password' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  return { s, env, store, request };
}
test('missing region KV uses the existing US pool without writing defaults', async () => {
  const { s, env, store } = await session();
  const config = await s.读取区域配置(env);
  assert.equal(config.defaultRegion, 'US');
  assert.deepEqual(Array.from(config.regions[0].exits), POOL.map(ip => ip + ':443'));
  assert.equal(store.has('regions.json'), false);
});
test('real proxy endpoint selects configured JP and ignores arbitrary overrides', async () => {
  const { s, env } = await session(regions());
  s.处理WS请求 = async (_, __, ___, context) => Response.json(context);
  const req = new Request(ORIGIN + '/?region=JP&proxyip=203.0.113.1&socks5=203.0.113.2:1080', { headers: { Upgrade: 'websocket' } });
  Object.defineProperty(req, 'cf', { value: { colo: 'SJC' } });
  const response = await s.worker.fetch(req, env, {});
  assert.equal(response.status, 200);
  const context = await response.json();
  assert.equal(context.反代IP, '8.8.8.8:443,9.9.9.9:443');
  assert.equal(context.反代兜底, false);
  assert.equal(context.代理全局, true);
});
test('unknown, empty and duplicate regions are rejected before protocol handling', async () => {
  const { s, env } = await session(regions()); let called = false;
  s.处理WS请求 = async () => { called = true; return new Response('incorrect fallback'); };
  for (const query of ['region=GB', 'region=', 'region=US&region=JP']) {
    const req = new Request(ORIGIN + '/?' + query, { headers: { Upgrade: 'websocket' } });
    Object.defineProperty(req, 'cf', { value: { colo: 'SJC' } });
    assert.equal((await s.worker.fetch(req, env, {})).status, 400);
  }
  assert.equal(called, false);
});
test('corrupt or unavailable KV fails closed before proxy handling', async () => {
  for (const bad of ['{', JSON.stringify({ ...regions(), regions: [] })]) {
    const { s, env, store } = await session(regions());
    store.set('regions.json', bad);
    s.处理WS请求 = async () => new Response('incorrect fallback');
    const req = new Request(ORIGIN + '/', { headers: { Upgrade: 'websocket' } });
    Object.defineProperty(req, 'cf', { value: { colo: 'SJC' } });
    assert.equal((await s.worker.fetch(req, env, {})).status, 503);
    env.KV.get = async () => { throw new Error('KV unavailable'); };
    assert.equal((await s.worker.fetch(req, env, {})).status, 503);
  }
});
test('concurrent selected regions keep independent proxy contexts', async () => {
  const { s, env } = await session(regions());
  const contexts = await Promise.all(['US', 'JP', 'US', 'JP'].map(region =>
    s.反代参数获取(new URL(ORIGIN + '/?region=' + region), UUID, '', true, env)));
  assert.deepEqual(contexts.map(c => c.反代IP), [POOL.map(ip => ip + ':443').join(','),
    '8.8.8.8:443,9.9.9.9:443', POOL.map(ip => ip + ':443').join(','), '8.8.8.8:443,9.9.9.9:443']);
});
test('JP backup is tried in order, all JP failures never try US or direct', async () => {
  for (const failures of [['8.8.8.8'], ['8.8.8.8', '9.9.9.9']]) {
    const attempts = []; const s = load(({ hostname }) => { attempts.push(hostname); return socket(hostname, failures.includes(hostname)); });
    const { env } = storage(regions());
    await seedVerifiedPool(s, env, await s.读取区域配置(env), new Request(ORIGIN));
    const context = await s.反代参数获取(new URL(ORIGIN + '/?region=JP'), UUID, '', true, env);
    const ws = { readyState: 1, close() { this.readyState = 3; } };
    const result = s.forwardataTCP('chatgpt.com', 443, new Uint8Array([1]), ws, null, {}, UUID, {}, context, false, null, true);
    if (failures.length === 2) { await assert.rejects(result, /所有反代连接失败/); assert.equal(ws.readyState, 3); }
    else assert.equal((await result).hostname, '9.9.9.9');
    assert.deepEqual(attempts, ['8.8.8.8', '9.9.9.9']);
  }
});
test('regional admin endpoints require the existing login cookie', async () => {
  const { request } = await session();
  for (const path of ['/admin/regions', '/admin/regions.json']) {
    const response = await request(path, {}, false);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
  }
});
test('admin landing opens local regions panel, original settings remain accessible', async () => {
  const { request } = await session();
  const landing = await request('/admin');
  assert.equal(landing.status, 302);
  assert.equal(landing.headers.get('location'), '/admin/regions');
  const panel = await request('/admin/regions');
  assert.match(await panel.text(), /区域配置/);
  assert.equal(await (await request('/admin/settings')).text(), 'legacy settings');
});
test('valid regional config persists and supplies private local subscription links', async () => {
  const { request, store } = await session(); const config = regions(); config.defaultRegion = 'JP';
  const saved = await request('/admin/regions.json', { method: 'POST', headers: { Origin: ORIGIN,
    'Content-Type': 'application/json' }, body: JSON.stringify(config) });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(store.get('regions.json')).defaultRegion, 'JP');
  const loaded = await (await request('/admin/regions.json')).json();
  assert.equal(loaded.config.defaultRegion, 'JP');
  assert.match(loaded.subscriptions.clash, /target=clash/);
  assert.match(loaded.subscriptions.ss, /protocol=ss/);
});
test('invalid regional saves and malformed JSON preserve the prior KV config', async () => {
  const { request, store } = await session(regions()); const before = store.get('regions.json');
  const invalid = [
    { ...regions(), defaultRegion: 'GB' },
    { ...regions(), regions: [] },
    { ...regions(), regions: [regions().regions[0], regions().regions[0]] },
    { ...regions(), regions: [{ code: 'US', name: '美国', exits: [] }] },
    { ...regions(), regions: [{ code: 'US', name: '美国', exits: ['256.0.0.1:443'] }] },
    { ...regions(), regions: [{ code: 'US', name: '美国', exits: ['example.com:443'] }] },
    { ...regions(), regions: [{ code: 'US', name: '美国', exits: ['3.132.174.45:0'] }] }
  ];
  for (const body of [...invalid.map(JSON.stringify), '{']) {
    assert.equal((await request('/admin/regions.json', { method: 'POST', headers: {
      Origin: ORIGIN, 'Content-Type': 'application/json' }, body })).status, 400);
    assert.equal(store.get('regions.json'), before);
  }
});
test('writes require same-origin JSON, and storage failures return 503', async () => {
  const { request, env, store } = await session(regions()); const before = store.get('regions.json');
  for (const headers of [{ 'Content-Type': 'application/json' }, { Origin: 'https://evil.invalid',
    'Content-Type': 'application/json' }, { Origin: ORIGIN, 'Content-Type': 'text/plain' }]) {
    assert.equal((await request('/admin/regions.json', { method: 'POST', headers, body: JSON.stringify(regions()) })).status, 403);
    assert.equal(store.get('regions.json'), before);
  }
  env.KV.put = async () => { throw new Error('write unavailable'); };
  assert.equal((await request('/admin/regions.json', { method: 'POST', headers: {
    Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(regions()) })).status, 503);
});
test('subscriptions default to all regions with US first and explicit regional paths', async () => {
  const { s, request } = await session(regions()); const token = await s.MD5MD5('us.naiops.ccwu.cc' + UUID);
  const response = await request('/sub?token=' + token + '&target=clash');
  assert.equal(response.status, 200); const config = JSON.parse(await response.text());
  assert.equal(config.proxies.length, 4);
  assert.equal(config['proxy-groups'][0].type, 'select');
  assert.match(config['proxy-groups'][0].proxies[0], /US/);
  assert.deepEqual(config['proxy-groups'].filter(g => g.type === 'fallback').map(g => g.proxies.length), [2, 2]);
  assert.ok(config.proxies.every(p => (p['ws-opts']?.path || p['plugin-opts']?.path).includes('region=')));
  assert.ok(config['proxy-groups'].every(g => !g.proxies.includes('DIRECT')));
});
test('selected SS and VLESS subscriptions stay in JP, unknown regions fail', async () => {
  const { s, request } = await session(regions()); const token = await s.MD5MD5('us.naiops.ccwu.cc' + UUID);
  for (const protocol of ['vless', 'ss']) {
    const response = await request(`/sub?token=${token}&target=mixed&protocol=${protocol}&region=JP&b64`);
    assert.equal(response.status, 200); const links = atob(await response.text()).split('\n');
    assert.equal(links.length, 1);
    const link = new URL(links[0]);
    assert.equal(link.hash, '#JP-' + protocol.toUpperCase());
    const path = protocol === 'ss' ? link.searchParams.get('plugin') : link.searchParams.get('path');
    assert.match(path, /region=JP/);
    if (protocol === 'ss') assert.match(path, /enc=aes-128-gcm/);
  }
  assert.equal((await request(`/sub?token=${token}&target=clash&region=GB`)).status, 400);
});

test('UDP DNS cannot bypass the region pool with a direct resolver socket', async () => {
  const calls = []; const s = load(address => {
    calls.push(address.hostname);
    return { writable: new WritableStream({ write() {} }), readable: new ReadableStream({ start(controller) { controller.close(); } }) };
  });
  const ws = { readyState: 1, close() { this.readyState = 3; } };
  await assert.rejects(s.forwardataudp(new Uint8Array([0, 1, 0]), ws, null, {}), /UDP/);
  assert.deepEqual(calls, []);
  assert.equal(ws.readyState, 3);
});

test('real concurrent subscriptions keep distinct host identities across KV awaits', async () => {
  const s = load(); const { env } = storage(regions()); delete env.HOST;
  let enter, release;
  const waiting = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let readCount = 0;
  const get = env.KV.get;
  env.KV.get = async key => { if (key === 'tg.json' && ++readCount === 1) { enter(); await gate; } return get(key); };
  async function subscription(host) {
    const token = await s.MD5MD5(host + UUID);
    const req = new Request(`https://${host}/sub?token=${token}&target=mixed&protocol=vless&region=US&b64`, { headers: { 'User-Agent': 'region-test' } });
    Object.defineProperty(req, 'cf', { value: { colo: 'SJC', asn: 16509 } });
    return s.worker.fetch(req, env, { waitUntil() {} });
  }
  const firstPromise = subscription('a.invalid');
  await waiting;
  const second = await subscription('b.invalid');
  release();
  const first = await firstPromise;
  assert.equal(new URL(atob(await first.text())).hostname, 'a.invalid');
  assert.equal(new URL(atob(await second.text())).hostname, 'b.invalid');
});

test('missing or incomplete KV rejects admin regions before camouflage routes', async () => {
  const { request, env } = await session();
  for (const kv of [undefined, {}, { get: async () => null }]) {
    env.KV = kv;
    const response = await request('/admin/regions.json');
    assert.equal(response.status, 503);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.match((await response.json()).error, /KV/);
  }
});
