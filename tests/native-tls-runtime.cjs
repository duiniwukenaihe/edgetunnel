const {spawn,execFileSync}=require('node:child_process');
const tls=require('node:tls'),net=require('node:net'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const binary=process.env.WORKERD_BINARY;
if(!binary||!fs.existsSync(binary))throw new Error('Set WORKERD_BINARY to an existing workerd executable.');
const output=process.argv[2];if(!output)throw new Error('Provide an external JSON report path.');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'naiops-tls-preflight-'));
const report={purpose:'production policy TLS functions in native workerd with controlled CA fixtures',pid:process.pid,temporaryDirectory:directory,results:[]};
let worker,validServer,badServer,childLog='';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>server?server.close(resolve):resolve());
function cert(name){execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',directory+'/'+name+'.key','-out',directory+'/'+name+'.crt','-days','1','-subj','/CN=www.cloudflare.com','-addext','subjectAltName=DNS:www.cloudflare.com'],{stdio:'ignore'});return {key:fs.readFileSync(directory+'/'+name+'.key'),cert:fs.readFileSync(directory+'/'+name+'.crt')};}
(async()=>{
 try{
  const valid=cert('valid'),bad=cert('bad');
  validServer=tls.createServer(valid,s=>s.on('data',()=>s.end('HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\nip=3.132.174.45\nloc=US\n')));validServer.on('tlsClientError',()=>{});
  badServer=tls.createServer(bad,s=>s.on('data',()=>s.end('HTTP/1.0 200 OK\r\n\r\nloc=US\n')));badServer.on('tlsClientError',()=>{});
  const validPort=await listen(validServer),badPort=await listen(badServer);
  const reservation=net.createServer();const httpPort=await listen(reservation);await close(reservation);
  const policy=fs.readFileSync(path.resolve(__dirname,'../policy/auto-exits.js'),'utf8');
  report.policySha256=require('node:crypto').createHash('sha256').update(policy).digest('hex');
  const script=`import {connect as nativeConnect} from 'cloudflare:sockets';
let fixtureMode;
function connect(address,options){return nativeConnect({hostname:'127.0.0.1',port:fixtureMode==='/badcert'?${badPort}:${validPort}},options);}
function 区域错误(message,status=400){return Object.assign(new Error(message),{status});}
const 发布版本='controlled-fixture';
${policy}
export default {async fetch(request){fixtureMode=new URL(request.url).pathname;
try{if(fixtureMode==='/pool'){const result=await 探测区域出口('3.132.174.45:443','US');return Response.json({success:true,result});}
 const text=await 读取验证TLS响应('3.132.174.45:443',fixtureMode==='/wrongname'?'invalid.naiops.test':'www.cloudflare.com');const result=解析出口检测响应(text,'US');return Response.json({success:true,result});}
catch(e){return Response.json({success:false,error:e.message,stage:e.probeStage});}
}};`;
  fs.writeFileSync(directory+'/worker.js',script);
  fs.writeFileSync(directory+'/config.capnp',`using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "probe",worker = (modules = [(name = "main",esModule = embed "worker.js")],compatibilityDate = "2026-10-08")),(name = "internet",network = (allow = ["local"],tlsOptions = (trustBrowserCas = true,trustedCertificates = [embed "valid.crt"])))],sockets = [(name = "http",address = "127.0.0.1:${httpPort}",http = (),service = "probe")]);`);
  worker=spawn(binary,['serve',directory+'/config.capnp'],{stdio:['ignore','pipe','pipe']});report.workerPid=worker.pid;
  worker.stdout.on('data',b=>childLog+=b);worker.stderr.on('data',b=>childLog+=b);
  for(let attempt=0;attempt<60;attempt++){try{const r=await fetch('http://127.0.0.1:'+httpPort+'/valid');report.results.push({mode:'/valid',...await r.json()});break;}catch{await new Promise(r=>setTimeout(r,50));}}
  for(const mode of ['/wrongname','/badcert','/pool'])report.results.push({mode,...await(await fetch('http://127.0.0.1:'+httpPort+mode)).json()});
  console.log(JSON.stringify(report.results));
  assert.equal(report.results[0].success,true);assert.equal(report.results[1].success,false);assert.equal(report.results[2].success,false);
  assert.equal(report.results[0].result.country,'US');assert.equal(report.results[1].stage,'tls');assert.equal(report.results[2].stage,'tls');if(!report.results[3].success)assert.match(report.results[3].error,/明确/);report.safetyTestsPassed=true;report.runtimeReady=report.results[3].success;
  if(!report.runtimeReady)report.blocker='Native runtime hides certificate-name errors as generic Network connection lost; strict pool gate correctly rejects the candidate.';
 }finally{
  if(worker&&worker.exitCode===null&&worker.signalCode===null){worker.kill('SIGTERM');await new Promise(resolve=>worker.once('exit',resolve));}await close(validServer);await close(badServer);
  report.log=childLog;fs.rmSync(directory,{recursive:true,force:true});report.cleaned=!fs.existsSync(directory);
  fs.writeFileSync(output,JSON.stringify(report,null,2));
 }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
