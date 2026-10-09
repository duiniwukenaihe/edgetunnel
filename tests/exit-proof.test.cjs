const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { load } = require('./helpers/worker.cjs');
const origin = 'https://preview.example.com', nonce = 'a'.repeat(32);
function fixture(country = 'US') {
  const s = load(() => { throw new Error('receipt endpoint must not open sockets'); });
  s.fetch = async () => new Response('unhandled route', {status:404});
  let key='1'.repeat(64);
  const env = { ADMIN: 'fixture-only-private-password', KV:{get:async()=>key,put:async(_,value)=>{key=value;}} };
  const request = new Request(origin + '/__naiops_exit_probe?nonce=' + nonce,
    {headers: {'CF-Connecting-IP': '3.132.174.45'}});
  Object.defineProperty(request, 'cf', {value: {country, colo: 'CMH'}});
  return {s, env, request};
}
test('receipt endpoint signs observed country without exposing credentials or probing', async () => {
  const f = fixture(); const response = await f.s.worker.fetch(f.request, f.env, {});
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.country, 'US'); assert.equal(receipt.ip, '3.132.174.45');
  assert.equal(receipt.hostname, 'preview.example.com');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(JSON.stringify(receipt).includes(f.env.ADMIN), false);
  assert.equal((await f.s.验证出口回执(receipt, f.env, f.request, nonce, 'US')).country, 'US');
});
test('receipt rejects forgery, replay against another nonce, host, release and stale timestamp', async () => {
  const f = fixture(); const receipt = await (await f.s.处理出口回执(f.request, f.env)).json();
  for (const changed of [{...receipt, country:'JP'}, {...receipt, ip:'9.9.9.9'},
    {...receipt, hostname:'another.example.com'}, {...receipt, revision:'another-release'},
    {...receipt, issuedAt:Date.now()-30000}, {...receipt, signature:'0'.repeat(64)}])
    await assert.rejects(f.s.验证出口回执(changed, f.env, f.request, nonce, 'US'));
  await assert.rejects(f.s.验证出口回执(receipt, f.env, f.request, 'b'.repeat(32), 'US'));
  assert.equal((await f.s.验证出口回执(receipt, {...f.env, ADMIN:'different'}, f.request, nonce, 'US')).country,'US');
  await assert.rejects(f.s.验证出口回执(receipt, {...f.env, KV:{get:async()=>'2'.repeat(64)}}, f.request, nonce, 'US'));
});
test('Worker subrequests and their synthetic addresses cannot produce egress evidence', async () => {
  const f=fixture();
  for(const headers of [{'CF-Connecting-IP':'3.132.174.45','CF-Worker':'attacker.example.com'},
    {'CF-Connecting-IP':'2a06:98c0:3600::103'}, {'CF-Connecting-IP':'2a06:98c0:3600:0:0:0:103'}]) {
    const request=new Request(f.request.url,{headers});Object.defineProperty(request,'cf',{value:{country:'US'}});
    assert.equal((await f.s.处理出口回执(request,f.env)).status,503);
  }
});
test('runtime never creates or rotates the receipt key, including repeated absent reads', async () => {
  const f=fixture();let key=null,writes=0;
  f.env.KV={get:async()=>key,put:async(_,value)=>{key=value;writes++;}};
  assert.equal((await f.s.处理出口回执(f.request,f.env)).status,503);assert.equal(writes,0);
  await assert.rejects(f.s.确保出口回执密钥(f.env),/密钥/);
  await assert.rejects(f.s.确保出口回执密钥(f.env),/密钥/);
  assert.equal(key,null);assert.equal(writes,0);
  key='1'.repeat(64);await f.s.确保出口回执密钥(f.env);assert.equal(writes,0);
});
test('authentic wrong-country receipt is rejected and revokes an old exit', async () => {
  const f=fixture('JP');const receipt=await(await f.s.处理出口回执(f.request,f.env)).json();
  await assert.rejects(f.s.验证出口回执(receipt,f.env,f.request,nonce,'US'), e=>e.invalidatesExit===true);
});
test('receipt endpoint rejects missing country, private IP, invalid nonce and non-GET', async () => {
  for(const country of ['', 'XX','T1']){const f=fixture(country);assert.equal((await f.s.处理出口回执(f.request,f.env)).status,503);}
  const f=fixture();
  for(const request of [new Request(origin+'/__naiops_exit_probe'),
    new Request(origin+'/__naiops_exit_probe?nonce='+nonce,{method:'POST'}),
    new Request(origin+'/__naiops_exit_probe?nonce='+nonce,{headers:{'CF-Connecting-IP':'127.0.0.1'}})])
    assert.notEqual((await f.s.处理出口回执(request,f.env)).status,200);
});
test('receipt HTTP parser accepts bounded JSON and chunks, rejects non-200 and malformed framing', () => {
  const f=fixture(), body=JSON.stringify({nonce,signature:'0'.repeat(64)});
  const header='HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n';
  assert.equal(f.s.解析候选回执响应(header+'Content-Length: '+body.length+'\r\n\r\n'+body).nonce,nonce);
  const chunk=body.length.toString(16)+'\r\n'+body+'\r\n0\r\n\r\n';
  assert.equal(f.s.解析候选回执响应(header+'Transfer-Encoding: chunked\r\n\r\n'+chunk).nonce,nonce);
  for(const text of [header.replace('200','403')+'\r\n'+body,header+'Content-Length: 2\r\n\r\n'+body,
    header+'Transfer-Encoding: chunked\r\n\r\n'+chunk.replace('0\r\n\r\n',''),header+'\r\n\r\nnot json'])
    assert.throws(()=>f.s.解析候选回执响应(text));
});
test('probe sends only a new nonce to current project SNI and accepts only an authentic receipt', async () => {
  const f=fixture();let sent='',sni='',closed=0,answer,reads=0;
  f.s.connect=()=>({opened:Promise.resolve(),closed:Promise.resolve(),close(){closed++;}});
  f.s.FixtureTlsClient=class {
    constructor(raw,options){sni=options.serverName;}
    async handshake(){}
    async write(data){sent=new TextDecoder().decode(data);const path=sent.split(' ')[1];
      const request=new Request(origin+path,{headers:{'CF-Connecting-IP':'3.132.174.45'}});
      Object.defineProperty(request,'cf',{value:{country:'US'}});
      const response=await f.s.处理出口回执(request,f.env);
      answer=new TextEncoder().encode('HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n'+await response.text());}
    async read(){return reads++?null:answer;}
    close(){closed++;}
  };
  vm.runInContext('TlsClient = globalThis.FixtureTlsClient',f.s);
  const result=await f.s.探测区域出口('3.132.174.45:443','US',undefined,f.env,f.request);
  assert.equal(result.country,'US');assert.equal(result.proofVerified,true);
  assert.equal(result.tlsNameVerified,undefined);assert.equal(sni,'preview.example.com');
  assert.match(sent,/GET \/__naiops_exit_probe\?nonce=[0-9a-f]{32} HTTP\/1.0/);
  assert.equal(sent.includes(f.env.ADMIN),false);assert.ok(closed>0);
});
