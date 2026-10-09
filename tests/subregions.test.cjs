const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
function fixture() {
  let now = 1800000000000;
  const store = new Map([['__naiops_exit_receipt_key_v1', '1'.repeat(64)]]), probes = [], writes = [];
  const s = { URL, URLSearchParams, Response, Request, TextEncoder, TextDecoder, ReadableStream,
    AbortController, crypto: webcrypto, performance: { now: () => 0 }, setTimeout, clearTimeout, btoa,
    Date: class extends Date { static now() { return now; } }, 发布版本: 'subregion-fixture' };
  vm.createContext(s);
  vm.runInContext(['regions','exit-proof','auto-exits'].map(name => fs.readFileSync(path.resolve(__dirname, '../policy/'+name+'.js'),'utf8')).join('\n'), s);
  const env = { KV: { get: async key => store.get(key) ?? null,
    put: async (key,value) => { writes.push(key); store.set(key,value); } } };
  const request = new Request('https://proof.example.com/');
  Object.defineProperty(request,'cf',{value:{colo:'SJC'}});
  const config = s.默认区域配置(), region = config.regions[0];
  const select = code => s.选择区域(config, new URL(request.url+'?region='+code));
  let candidates = ['8.8.8.1:443','8.8.8.2:443','8.8.8.3:443'];
  const states = new Map([[candidates[0],'CA'],[candidates[1],'NY'],[candidates[2],null]]);
  s.发现区域候选 = async () => candidates;
  async function receipt(regionCode, nonce='a'.repeat(32), city='Los Angeles', country='US') {
    const req = new Request(request.url+'__naiops_exit_probe?nonce='+nonce,{headers:{'CF-Connecting-IP':'9.9.9.9'}});
    Object.defineProperty(req,'cf',{value:{country, regionCode, city}});
    return (await s.处理出口回执(req,env)).json();
  }
  s.读取候选回执 = async (address,host,nonce) => { probes.push(address); return receipt(states.get(address), nonce); };
  const probe = s.探测区域出口;
  s.探测区域出口 = async (...args) => ({ ...await probe(...args), latency: Number(args[0].split(':')[0].split('.').pop()) });
  return { s, env, request, region, config, select, probes, store, writes, states, receipt,
    advance: ms => { now += ms; }, now: () => now, candidates: value => { candidates = value; } };
}
const plain = value => JSON.parse(JSON.stringify(value));
test('v2 receipt binds state and city and classifies only the signed US state', async () => {
  const f=fixture(), receipt=await f.receipt('CA');
  assert.equal(receipt.version,2);
  const result=await f.s.验证出口回执(receipt,f.env,f.request,'a'.repeat(32),'US');
  assert.equal(result.area,'west'); assert.equal(result.regionCode,'CA'); assert.equal(result.city,'Los Angeles');
  for(const patch of [{regionCode:'NY'},{city:'New York'}])
    await assert.rejects(f.s.验证出口回执({...receipt,...patch},f.env,f.request,'a'.repeat(32),'US'),e=>e.invalidatesExit===true);
  for(const state of [null,'ZZ']) {
    const unknown=await f.receipt(state);
    assert.equal((await f.s.验证出口回执(unknown,f.env,f.request,'a'.repeat(32),'US')).area,null);
  }
});
test('all 51 jurisdictions use the approved project grouping', () => {
  const f=fixture(), expected={west:'AK AZ CA CO HI ID MT NM NV OR UT WA WY',east:'CT DE DC FL GA MA MD ME NC NH NJ NY PA RI SC VA VT WV',central:'AL AR IA IL IN KS KY LA MI MN MO MS ND NE OH OK SD TN TX WI'};
  const codes=Object.values(expected).join(' ').split(' '); assert.equal(new Set(codes).size,51);
  for(const [area,list] of Object.entries(expected)) for(const state of list.split(' ')) assert.equal(f.s.美国州区域(state),area);
});
test('derived subscriptions are nine unique named selectors without modifying country config', () => {
  const f=fixture(), before=JSON.stringify(f.config), entries=plain(f.s.订阅区域列表(f.config));
  assert.deepEqual(entries.map(e=>e.code),['US','US-EAST','US-CENTRAL','US-WEST','JP','SG','HK','DE','GB']);
  assert.equal(entries[0].name,'Naiops-US · 美国自动'); assert.equal(entries[1].name,'Naiops-US-EAST · 美国东部');
  assert.equal(new Set(entries.map(e=>e.name)).size,9); assert.equal(JSON.stringify(f.config),before);
  assert.equal(f.select('us-west').country,'US'); assert.equal(f.select('US-WEST').area,'west');
  assert.deepEqual(plain(f.select('US-WEST').exits),plain(f.region.exits));
  const client={HOST:'proof.example.com',UUID:'fixture'};
  assert.equal(f.s.生成区域通用订阅(client,'vless',f.config).split('\n').length,9);
  assert.equal(f.s.生成区域通用订阅(client,'vless',f.config,f.select('US')).split('\n').length,1);
  const clash=JSON.parse(f.s.生成区域Clash订阅(client,f.config)); assert.equal(clash.proxies.length,18);
  assert.equal(new Set(clash.proxies.map(p=>p.name)).size,18);
  f.config.regions=f.config.regions.filter(e=>e.code!=='US');f.config.defaultRegion='JP';
  assert.equal(f.s.订阅区域列表(f.config).length,5);assert.throws(()=>f.select('US-WEST'));
});
test('empty duplicate and unsupported derived selectors fail before work', () => {
  const f=fixture();for(const query of ['region=','region=US&region=US-WEST','region=SG-WEST','region=US-NORTH'])
    assert.throws(()=>f.s.选择区域(f.config,new URL(f.request.url+'?'+query)));
});
test('parent and subregions share one refresh while country-only evidence stays in US', async () => {
  const f=fixture(), west=f.select('US-WEST'), east=f.select('US-EAST');
  assert.equal(await f.s.区域池缓存键(west,f.request),await f.s.区域池缓存键(f.region,f.request));
  const [a,b]=await Promise.all([f.s.获取有效区域池(f.env,west,f.request),f.s.获取有效区域池(f.env,east,f.request)]);
  assert.deepEqual(plain(a.exits.map(e=>e.regionCode)),['CA']);assert.deepEqual(plain(b.exits.map(e=>e.regionCode)),['NY']);
  assert.equal(f.probes.length,3);assert.equal(f.writes.length,1);
  const parent=await f.s.获取有效区域池(f.env,f.select('US'),f.request);assert.equal(parent.exits.length,3);
  a.exits.pop();assert.equal((await f.s.获取有效区域池(f.env,west,f.request)).exits.length,1);
});
test('missing subregions progress the shared cursor only after a global 60 second cooldown', async () => {
  const f=fixture();f.candidates(Array.from({length:12},(_,i)=>`8.8.8.${i+1}:443`));
  for(let i=1;i<=12;i++)f.states.set(`8.8.8.${i}:443`,'CA');
  for(const code of ['US-EAST','US-CENTRAL','US-EAST']) await assert.rejects(f.s.获取有效区域池(f.env,f.select(code),f.request),/出口|区域/);
  assert.equal(f.probes.length,4);f.advance(60000);
  await Promise.all(['US-EAST','US-CENTRAL'].map(code=>assert.rejects(f.s.获取有效区域池(f.env,f.select(code),f.request))));
  assert.equal(f.probes.length,8);assert.ok(new Set(f.probes).size>4);
});
test('partial refresh merges valid backups preserving checkedAt and healthy primary', async () => {
  const f=fixture();const first=await f.s.获取有效区域池(f.env,f.select('US'),f.request);
  f.advance(16*60000);f.candidates(['8.8.8.1:443','8.8.8.4:443']);f.states.set('8.8.8.4:443','TX');
  const second=await f.s.获取有效区域池(f.env,f.select('US'),f.request);
  assert.equal(second.exits.length,4);assert.equal(second.exits[0].address,'8.8.8.1:443');
  assert.equal(second.exits.find(e=>e.address==='8.8.8.2:443').checkedAt,first.exits[1].checkedAt);
  assert.equal(second.discoveredCount,2);assert.equal(second.probedCount,2);
  f.advance(15*60000);f.s.探测区域出口=async()=>{throw new Error('offline');};
  const third=await f.s.获取有效区域池(f.env,f.select('US'),f.request);
  assert.deepEqual(new Set(third.exits.map(e=>e.address)),new Set(['8.8.8.1:443','8.8.8.4:443']));
  await assert.rejects(f.s.获取有效区域池(f.env,f.select('US-EAST'),f.request));
});
test('state moves and signature tampering revoke old subregion evidence even on KV write outage', async () => {
  for(const tamper of [false,true]) {
    const f=fixture();await f.s.获取有效区域池(f.env,f.select('US-WEST'),f.request);f.advance(16*60000);
    const read=f.s.读取候选回执;f.s.读取候选回执=async(...args)=>{const r=await read(...args);return args[0]==='8.8.8.1:443'?{...r,regionCode:'NY',...(tamper?{}:await f.receipt('NY',args[2]))}:r;};
    f.env.KV.put=async()=>{throw new Error('outage');};
    await assert.rejects(f.s.获取有效区域池(f.env,f.select('US-WEST'),f.request),/保存/);
    const {entry}=await f.s.读取出口池状态(f.env,f.select('US'),f.request);
    assert.equal(entry.pool.exits.some(e=>e.address==='8.8.8.1:443'),false);
  }
});
test('cache rejects invalid geo and counters while an expired member cannot invalidate a fresh one', async () => {
  const f=fixture(), pool=await f.s.获取有效区域池(f.env,f.select('US'),f.request);
  for(const patch of [{discoveredCount:33},{probedCount:5},{cursor:-1}]) assert.throws(()=>f.s.验证出口池({...pool,...patch},'US'));
  const bad=plain(pool);bad.exits[0].area='east';assert.throws(()=>f.s.验证出口池(bad,'US'));
  const old=plain(pool);old.exits[0].checkedAt-=31*60000;
  assert.doesNotThrow(()=>f.s.验证出口池(old,'US'));
  assert.equal(f.s.区域池视图(old,f.select('US-WEST')).exits.length,0);
  assert.equal(f.s.区域池视图(old,f.select('US-EAST')).exits.length,1);
  assert.match(await f.s.区域池缓存键(f.region,f.request),/^exit-pool:v3:/);
});
test('legacy country-only probe fixtures cannot acquire a derived area from unsigned fields', async () => {
  const f=fixture();f.s.探测区域出口=async address=>({address,exitIP:'9.9.9.9',country:'US',checkedAt:f.now(),latency:1,proofVerified:true});
  assert.equal((await f.s.获取有效区域池(f.env,f.select('US'),f.request)).exits.length,3);
  await assert.rejects(f.s.获取有效区域池(f.env,f.select('US-WEST'),f.request));
});

test('pool capacity retains observed east and central candidates even after a full west pool', async () => {
  const f=fixture();f.candidates(Array.from({length:16},(_,i)=>`8.8.8.${i+1}:443`));
  for(let i=1;i<=16;i++)f.states.set(`8.8.8.${i}:443`,i===11?'NY':i===12?'TX':'CA');
  await f.s.获取有效区域池(f.env,f.select('US'),f.request);
  for(let round=0;round<3;round++) { f.advance(60000); try { await f.s.获取有效区域池(f.env,f.select('US-CENTRAL'),f.request); } catch(error) { assert.equal(error.status,503); } }
  const parent=await f.s.获取有效区域池(f.env,f.select('US'),f.request);
  assert.equal(parent.exits.length,8);assert.ok(parent.exits.some(e=>e.area==='east'));assert.ok(parent.exits.some(e=>e.area==='central'));
  assert.equal(parent.exits[0].address,'8.8.8.1:443');
});

test('cache field validation rejects invalid timestamps and malformed failure evidence', async () => {
  const f=fixture(), pool=await f.s.获取有效区域池(f.env,f.select('US'),f.request);
  for(const patch of [{lastAttemptAt:-1},{nextRefreshAt:pool.lastAttemptAt-1},{expiresAt:-1},
    {failures:[{address:'source',reason:5}]},{failures:[{address:null,reason:'offline'}]},
    {failures:[{address:'8.8.8.1:443',reason:'bad',invalidatesExit:'true'}]}])
    assert.throws(()=>f.s.验证出口池({...pool,...patch},'US'));
});

test('every received invalid envelope withdraws old proof with and without a write outage', async () => {
  const patches=[{signature:'bad'},{version:1},{nonce:'b'.repeat(32)},{hostname:'other.example.com'},
    {revision:'old'},{issuedAt:0},{signature:'0'.repeat(64)}];
  for(const patch of patches) for(const outage of [false,true]) {
    const f=fixture();await f.s.获取有效区域池(f.env,f.select('US-WEST'),f.request);f.advance(16*60000);
    const read=f.s.读取候选回执;f.s.读取候选回执=async(...args)=>({...await read(...args),...(args[0]==='8.8.8.1:443'?patch:{})});
    if(outage)f.env.KV.put=async()=>{throw new Error('outage');};
    await assert.rejects(f.s.获取有效区域池(f.env,f.select('US-WEST'),f.request));
    const {entry}=await f.s.读取出口池状态(f.env,f.select('US'),f.request);
    assert.equal(entry.pool.exits.some(e=>e.address==='8.8.8.1:443'),false,JSON.stringify({patch,outage}));
  }
});
test('non-durable revocation survives same-isolate cache eviction', async () => {
  const f=fixture();await f.s.获取有效区域池(f.env,f.select('US-WEST'),f.request);f.advance(60000);
  f.states.set('8.8.8.1:443','NY');f.env.KV.put=async()=>{throw new Error('outage');};
  await assert.rejects(f.s.获取有效区域池(f.env,f.select('US-WEST'),f.request,true));
  for(let i=0;i<32;i++)await f.s.读取出口池状态(f.env,f.select('US'),new Request('https://churn'+i+'.example.com/'));
  await assert.rejects(f.s.获取有效区域池(f.env,f.select('US-WEST'),f.request));
});
test('bounded revocation authority fails closed instead of dropping unexpired withdrawal', async () => {
  const f=fixture();f.candidates(['8.8.8.1:443']);
  for(let i=0;i<257;i++) {
    const request=new Request(f.request.url);Object.defineProperty(request,'cf',{value:{colo:'C'+i}});
    f.states.set('8.8.8.1:443','CA');
    await f.s.获取有效区域池(f.env,f.select('US-WEST'),request);
  }
  f.advance(60000);const put=f.env.KV.put;f.env.KV.put=async()=>{throw new Error('outage');};f.states.set('8.8.8.1:443','NY');
  for(let i=0;i<257;i++) { const request=new Request(f.request.url);Object.defineProperty(request,'cf',{value:{colo:'C'+i}});await assert.rejects(f.s.获取有效区域池(f.env,f.select('US-WEST'),request,true)); }
  f.env.KV.put=put;
  await assert.rejects(f.s.获取有效区域池(f.env,f.select('US'),f.request),/撤销|出口/);
});
test('availability states use raw evidence without starting probes', async () => {
  const f=fixture(), west=f.select('US-WEST');
  assert.equal(f.s.区域不可用状态(null,west),'not_checked');
  const pool=await f.s.获取有效区域池(f.env,f.select('US'),f.request);
  assert.equal(f.s.区域不可用状态(pool,west),null);
  f.advance(31*60000);assert.equal(f.s.区域不可用状态(pool,west),'expired');
  const base={...pool,exits:[],failures:[{address:'source-A',reason:'offline'}]};
  assert.equal(f.s.区域不可用状态(base,west),'source_failed');
  const fresh={...pool,exits:pool.exits.map(e=>({...e,checkedAt:f.now(),regionCode:null,area:null}))};
  assert.equal(f.s.区域不可用状态(fresh,west),'missing_geo');
  fresh.exits=fresh.exits.map(e=>({...e,regionCode:'NY',area:'east'}));
  assert.equal(f.s.区域不可用状态(fresh,west),'area_unavailable');
  assert.equal(f.s.区域不可用状态({...base,failures:[]},f.select('US')),'country_unavailable');
  assert.equal(f.probes.length,3);
});
test('generated candidate loop consults current authority after a concurrent signed-state refresh', async () => {
  const f=fixture();f.candidates(['8.8.8.1:443','8.8.8.2:443']);f.states.set('8.8.8.2:443','CA');
  await f.s.获取有效区域池(f.env,f.select('US-WEST'),f.request);
  const {load,socket,UUID}=require('./helpers/worker.cjs');const calls=[];let rejectFirst;
  const s=load(({hostname})=>{calls.push(hostname);return hostname==='8.8.8.1'?{opened:new Promise((_,reject)=>{rejectFirst=reject;}),closed:Promise.resolve(),close(){}}:socket(hostname,false);});
  s.Date=class extends Date{static now(){return f.now();}};
  const context=await f.s.反代参数获取(new URL(f.request.url+'?region=US-WEST'),UUID,'',true,f.env,f.request);
  const task=s.forwardataTCP('chatgpt.com',443,new Uint8Array([1]),{readyState:1,close(){}},null,{},UUID,{},context,false,null,true);
  while(!rejectFirst)await new Promise(resolve=>setTimeout(resolve,1));
  f.advance(60000);f.states.set('8.8.8.2:443','NY');await f.s.获取有效区域池(f.env,f.select('US-WEST'),f.request,true);
  const probes=f.probes.length;rejectFirst(new Error('offline'));await assert.rejects(task);
  assert.deepEqual(calls,['8.8.8.1']);assert.equal(f.probes.length,probes);
});

test('invalid received HTTP proof framing revokes while empty transport EOF stays temporary', () => {
  const f=fixture();
  for(const text of ['HTTP/1.0 403 Forbidden\r\n\r\n{}','HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\ninvalid'])
    assert.throws(()=>f.s.解析候选回执响应(text),e=>e.invalidatesExit===true);
  assert.throws(()=>f.s.解析候选回执响应(''),e=>e.invalidatesExit===false);
});

test('completed geo change or invalid proof withdraws a held view before its sibling probe finishes', async () => {
  for(const invalid of [false,true,'temporary']) {
    const f=fixture();f.candidates(['8.8.8.1:443','8.8.8.2:443']);f.states.set('8.8.8.2:443','CA');
    const held=await f.s.获取有效区域池(f.env,f.select('US-WEST'),f.request), member=held.exits[0];
    f.advance(60000);let releaseSibling, completed=false;
    const probe=f.s.探测区域出口;
    f.s.探测区域出口=async(...args)=>{
      if(args[0]==='8.8.8.2:443')await new Promise(resolve=>{releaseSibling=resolve;});
      if(args[0]==='8.8.8.1:443') {
        if(invalid){completed=true;throw Object.assign(new Error(invalid==='temporary'?'transport timeout':'invalid received proof'),{invalidatesExit:invalid===true});}
        f.states.set(args[0],'NY');const result=await probe(...args);completed=true;return result;
      }
      return probe(...args);
    };
    const refresh=f.s.获取有效区域池(f.env,f.select('US-WEST'),f.request,true);
    while(!releaseSibling || !completed)await new Promise(resolve=>setTimeout(resolve,1));
    // Yield through completion of the async probe callback, while its sibling remains blocked.
    await new Promise(resolve=>setTimeout(resolve,1));
    try { assert.equal(held.验证当前出口(member),invalid==='temporary',invalid?'invalid/temporary proof':'signed state change'); }
    finally { releaseSibling();await refresh; }
  }
});

test('withdrawal capacity exhaustion immediately disables held dial authority', async () => {
  const f=fixture(), held=await f.s.获取有效区域池(f.env,f.select('US-WEST'),f.request), member=held.exits[0];
  assert.equal(held.验证当前出口(member),true);
  for(let i=0;i<256;i++)f.s.撤销旧出口(f.env.KV,'unpersisted-context-'+i,member);
  assert.equal(held.验证当前出口(member),true);
  f.s.撤销旧出口(f.env.KV,'overflow-context',member);
  assert.equal(held.验证当前出口(member),false);
  f.advance(31*60000);
  assert.equal(f.s.读取撤销权威(f.env.KV).withdrawals.size,0);
});
