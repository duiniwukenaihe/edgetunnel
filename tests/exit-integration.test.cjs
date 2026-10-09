const test = require('node:test');
const assert = require('node:assert/strict');
const { load, socket, UUID } = require('./helpers/worker.cjs');
const origin = 'https://us.naiops.ccwu.cc';
function fixture() {
  const calls = [], probes = [], tasks = [], store = new Map([['__naiops_exit_receipt_key_v1', '1'.repeat(64)]]);
  const s = load(({hostname}) => { calls.push(hostname); return socket(hostname, false); });
  const env = { ADMIN: 'integration-only', UUID, OFF_LOG: 'true', KV: {
    get: async key => store.get(key) ?? null, put: async (key, value) => store.set(key, value) } };
  s.发现区域候选 = async () => ['192.9.157.76:443'];
  s.探测区域出口 = async (address, country) => { probes.push(address); return {
    address, country, exitIP: '8.8.8.8', latency: 5, checkedAt: Date.now(), proofVerified: true }; };
  s.fetch = async () => new Response('external fixture');
  let cookie = '';
  async function request(path, options = {}, authenticated = false) {
    const req = new Request(origin + path, {...options, headers: { 'User-Agent': 'integration-test',
      ...(authenticated ? { Cookie: cookie } : {}), ...options.headers }});
    Object.defineProperty(req, 'cf', {value: {colo: 'SJC', asn: 16509}});
    return s.worker.fetch(req, env, {waitUntil(task) {tasks.push(task);}});
  }
  async function login() { const r = await request('/login', {method:'POST', body:'password=integration-only'});
    cookie = r.headers.get('set-cookie').split(';')[0]; }
  return {s, env, calls, probes, tasks, store, request, login};
}

test('v2 defaults discover US; old v1 configuration remains manual and read-only', async () => {
  const f = fixture(); const defaults = await f.s.读取区域配置(f.env);
  assert.equal(defaults.version, 2); assert.equal(defaults.regions[0].auto, true);
  assert.equal(defaults.regions[0].source, 'cmliu-us-dns');
  const old = JSON.stringify({version:1,defaultRegion:'US',regions:[{code:'US',name:'美国',exits:['3.132.174.45:443']}]});
  f.store.set('regions.json', old); const config = await f.s.读取区域配置(f.env);
  assert.equal(config.regions[0].auto, false); assert.equal(f.store.get('regions.json'), old);
  for (const region of [{code:'JP',name:'日本',exits:[],auto:true,source:'cmliu-us-dns'},
    {code:'US',name:'美国',exits:[],auto:true,source:'https://evil.invalid'},
    {code:'US',name:'美国',exits:['127.0.0.1:443'],auto:false,source:null}])
    assert.throws(() => f.s.验证区域配置({version:2,defaultRegion:region.code,regions:[region]}));
  assert.equal(f.s.验证区域配置({version:2,defaultRegion:'US',regions:[{code:'US',name:'美国',exits:[],auto:true,source:'cmliu-us-dns'}]}).regions[0].auto, true);
});

test('proxy context stays lazy; TCP resolves verified candidates and denies overrides', async () => {
  const f = fixture(); const req = new Request(origin + '/?proxyip=9.9.9.9&region=US');
  Object.defineProperty(req, 'cf', {value:{colo:'SJC'}});
  const context = await f.s.反代参数获取(new URL(req.url), UUID, '', true, f.env, req);
  assert.equal(f.probes.length, 0);
  const result = await f.s.forwardataTCP('chatgpt.com',443,new Uint8Array([1]),{readyState:1,close(){}},null,{},UUID,req,context,false,null,true);
  assert.equal(result.hostname, '192.9.157.76');
  assert.deepEqual(f.calls, ['192.9.157.76']); assert.equal(f.probes.length, 1);
});

test('unavailable verified pool never dials manual, direct or another country', async () => {
  const f = fixture(); f.s.探测区域出口 = async () => {throw new Error('wrong country');};
  const req = new Request(origin); const context = await f.s.反代参数获取(new URL(req.url), UUID, '', true, f.env, req);
  const ws = {readyState:1,close(){this.readyState=3;}};
  await assert.rejects(f.s.forwardataTCP('chatgpt.com',443,new Uint8Array([1]),ws,null,{},UUID,req,context,false,null,true), /出口/);
  assert.deepEqual(f.calls, []); assert.equal(ws.readyState, 3);
});

test('anonymous refresh and invalid subscription token never discover or probe', async () => {
  const f = fixture(); let discoveries = 0; f.s.发现区域候选 = async () => {discoveries++; return [];};
  assert.equal((await f.request('/admin/exits.json?region=US', {method:'POST', headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'})).status,302);
  await f.request('/sub?token=invalid&target=clash');
  assert.equal(discoveries,0); assert.equal(f.probes.length,0);
});

test('admin status reads without probes; refresh requires origin, uses region and rate limit', async () => {
  const f = fixture(); await f.login();
  const status = await f.request('/admin/exits.json?region=US', {}, true);
  assert.equal(status.status,200); assert.equal((await status.json()).pool,null); assert.equal(f.probes.length,0);
  assert.equal((await f.request('/admin/exits.json?region=US',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},true)).status,403);
  const options = {method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'};
  const fresh = await f.request('/admin/exits.json?region=US',options,true);
  assert.equal(fresh.status,200); assert.equal((await fresh.json()).pool.exits[0].country,'US');
  assert.equal((await f.request('/admin/exits.json?region=US',options,true)).status,429);
  assert.equal((await f.request('/admin/exits.json?region=JP',options,true)).status,400);
  assert.equal(f.probes.length,1);
});

test('valid subscription warms only the chosen region and keeps stable client paths', async () => {
  const f = fixture(); const token = await f.s.MD5MD5('us.naiops.ccwu.cc'+UUID);
  const response = await f.request(`/sub?token=${token}&target=clash&region=US`);
  assert.equal(response.status,200); const config = JSON.parse(await response.text());
  assert.equal(config.proxies[0]['ws-opts'].path,'/?region=US');
  await Promise.all(f.tasks); assert.equal(f.probes.length,1);
});

function vlessHeader(uuid) {
  const domain = new TextEncoder().encode('chatgpt.com');
  const bytes = Uint8Array.from(Buffer.from(uuid.replaceAll('-',''),'hex'));
  return Uint8Array.from([0,...bytes,0,1,1,187,2,domain.length,...domain,1]);
}
test('real WS parser rejects wrong UUID and bad SS ciphertext before any exit check', async () => {
  for (const ss of [false,true]) {
    const f = fixture(); let server;
    class WebSocketFixture extends EventTarget {
      readyState=1; accept(){} send(){} close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
    }
    f.s.WebSocketPair = class {constructor(){this[0]=new WebSocketFixture();this[1]=server=new WebSocketFixture();}};
    f.s.Response = class extends Response {constructor(body,options){super(body,options?.status===101?{...options,status:200}:options);}};
    await f.request(ss?'/?enc=aes-128-gcm':'/',{headers:{Upgrade:'websocket'}});
    server.dispatchEvent(new MessageEvent('message',{data:ss?new Uint8Array(100).buffer:vlessHeader('ffffffff-ffff-4fff-8fff-ffffffffffff').buffer}));
    for(let i=0;i<100&&server.readyState===1;i++)await new Promise(resolve=>setTimeout(resolve,1));
    assert.equal(server.readyState,3); assert.equal(f.probes.length,0); assert.deepEqual(f.calls,[]);
  }
});

test('real XHTTP and gRPC parsers reject wrong UUID without exit checks', async () => {
  const invalid = vlessHeader('ffffffff-ffff-4fff-8fff-ffffffffffff');
  const x = fixture(); const response = await x.request('/',{method:'POST',body:invalid});
  assert.equal(response.status,400); assert.equal(x.probes.length,0); assert.deepEqual(x.calls,[]);
  const g = fixture();
  const frame = Uint8Array.from([0,0,0,0,invalid.length,...invalid]);
  const grpc = await g.request('/',{method:'POST',headers:{'Content-Type':'application/grpc'},body:frame});
  await grpc.arrayBuffer(); assert.equal(g.probes.length,0); assert.deepEqual(g.calls,[]);
});

test('upstream public BEST_SUB request cannot warm or return our private subscription', async () => {
  const f = fixture(); f.env.BEST_SUB='true';
  const response = await f.request('/sub?host=example.com&uuid=00000000-0000-4000-8000-000000000000&target=clash',
    {headers:{'User-Agent':'tunnel (https://github.com/cmliu/edgetunnel)'}});
  assert.equal((await response.text()).includes(UUID),false); await Promise.all(f.tasks);
  assert.equal(f.probes.length,0);
});

test('a reused protocol context and its retry both reject expired exits', async () => {
  for (const retry of [false,true]) {
    const f=fixture();let now=Date.now();f.s.Date=class extends Date{static now(){return now;}};
    const probe=f.s.探测区域出口;f.s.探测区域出口=async(...args)=>({...await probe(...args),checkedAt:now});
    const req=new Request(origin);const context=await f.s.反代参数获取(new URL(req.url),UUID,'',true,f.env,req);
    const ws={readyState:1,close(){this.readyState=3;}},wrapper={};
    await f.s.forwardataTCP('chatgpt.com',443,new Uint8Array([1]),ws,null,wrapper,UUID,req,context,false,null,true);
    now+=31*60000;f.s.探测区域出口=async()=>{throw new Error('offline');};
    await assert.rejects(retry?wrapper.retryConnect():f.s.forwardataTCP('chatgpt.com',443,new Uint8Array([1]),ws,null,{},UUID,req,context,false,null,true),/出口/);
    assert.deepEqual(f.calls,['192.9.157.76']);
  }
});

test('failed authenticated refresh returns its stored per-candidate failure details', async () => {
  const f=fixture();await f.login();f.s.探测区域出口=async()=>{throw new Error('certificate hostname mismatch');};
  const response=await f.request('/admin/exits.json?region=US',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:'{}'},true);
  assert.equal(response.status,503);assert.match((await response.json()).pool.failures[0].reason,/certificate/);
});

test('a backup dial cannot use a pool that expired during the first dial', async () => {
  const f=fixture();let now=Date.now();f.s.Date=class extends Date{static now(){return now;}};
  f.s.发现区域候选=async()=>['3.132.174.45:443','192.9.157.76:443'];
  const probe=f.s.探测区域出口;f.s.探测区域出口=async(...args)=>({...await probe(...args),checkedAt:now});
  f.s.connect=({hostname})=>{f.calls.push(hostname);now+=31*60000;return socket(hostname,true);};
  const req=new Request(origin),context=await f.s.反代参数获取(new URL(req.url),UUID,'',true,f.env,req);
  await assert.rejects(f.s.forwardataTCP('chatgpt.com',443,new Uint8Array([1]),{readyState:1,close(){}},null,{},UUID,req,context,false,null,true),/过期/);
  assert.deepEqual(f.calls,['3.132.174.45']);
});
