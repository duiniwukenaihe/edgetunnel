const {spawn,execFileSync}=require('node:child_process');
const tls=require('node:tls'),net=require('node:net'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createHmac,createHash}=require('node:crypto'),assert=require('node:assert/strict');
const binary=process.env.WORKERD_BINARY,output=process.argv[2];
if(!binary||!fs.existsSync(binary)||!output)throw new Error('Existing WORKERD_BINARY and external JSON report path required.');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'naiops-proof-runtime-'));
const report={purpose:'actual upstream TLS transport and authenticated country receipt in native workerd',pid:process.pid,temporaryDirectory:directory,results:[]};
const key='1'.repeat(64),servers=[];let worker,childLog='';
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=server=>new Promise(resolve=>server.close(resolve));
(async()=>{
 try{
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',directory+'/key.pem','-out',directory+'/cert.pem','-days','1','-subj','/CN=proof.example.com','-addext','subjectAltName=DNS:proof.example.com'],{stdio:'ignore'});
  const cert={key:fs.readFileSync(directory+'/key.pem'),cert:fs.readFileSync(directory+'/cert.pem'),minVersion:'TLSv1.3',maxVersion:'TLSv1.3'};
  const ports={};
  for(const mode of ['valid','wrongcountry','forged','stale','replay','wronghost','wrongrelease']){
   const server=tls.createServer(cert,socket=>socket.once('data',data=>{
    assert.equal(socket.servername,'proof.example.com');
    const nonce=new URL(data.toString().split(' ')[1],'https://proof.example.com').searchParams.get('nonce');
    const receipt={version:1,nonce:mode==='replay'?'0'.repeat(32):nonce,hostname:mode==='wronghost'?'other.example.com':'proof.example.com',revision:mode==='wrongrelease'?'other-release':'__NAIOPS_RELEASE_SHA__',issuedAt:Date.now()-(mode==='stale'?30000:0),ip:'3.132.174.45',country:mode==='wrongcountry'?'JP':'US'};
    const signingKey=Buffer.from(key,'hex');
    receipt.signature=createHmac('sha256',signingKey).update(JSON.stringify([1,receipt.nonce,receipt.hostname,receipt.revision,receipt.issuedAt,receipt.ip,receipt.country])).digest('hex');
    if(mode==='forged')receipt.signature='0'.repeat(64);
    const body=JSON.stringify(receipt);socket.end('HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: '+Buffer.byteLength(body)+'\r\n\r\n'+body);
   }));server.on('tlsClientError',()=>{});servers.push(server);ports[mode]=await listen(server);
  }
  const reservation=net.createServer();const httpPort=await listen(reservation);await close(reservation);
  const source=fs.readFileSync(process.env.NAIOPS_SOURCE||path.resolve(__dirname,'../_worker.js'),'utf8');
  report.sourceSha256=createHash('sha256').update(source).digest('hex');
  const script=source.replace("import { connect } from 'cloudflare:sockets';",`import {connect as nativeConnect} from 'cloudflare:sockets';
let fixtureMode='valid';const fixturePorts=${JSON.stringify(ports)};
function connect(address,options){return nativeConnect({hostname:'127.0.0.1',port:fixturePorts[fixtureMode]},options);}`).replace('export default {','const originalWorker = {')+`
export default {async fetch(request){fixtureMode=new URL(request.url).pathname.slice(1)||'valid';
try{const result=await 探测区域出口('3.132.174.45:443','US',undefined,{KV:{get:async()=>${JSON.stringify(key)}}},new Request('https://proof.example.com/'));return Response.json({success:true,result});}
catch(error){return Response.json({success:false,error:error.message});}}};`;
  fs.writeFileSync(directory+'/worker.js',script);
  fs.writeFileSync(directory+'/config.capnp',`using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "probe",worker = (modules = [(name = "main",esModule = embed "worker.js")],compatibilityDate = "2026-10-08")),(name = "internet",network = (allow = ["local"]))],sockets = [(name = "http",address = "127.0.0.1:${httpPort}",http = (),service = "probe")]);`);
  worker=spawn(binary,['serve',directory+'/config.capnp'],{stdio:['ignore','pipe','pipe']});report.workerPid=worker.pid;
  worker.stdout.on('data',b=>childLog+=b);worker.stderr.on('data',b=>childLog+=b);
  for(let attempt=0;attempt<60;attempt++){try{const r=await fetch('http://127.0.0.1:'+httpPort+'/valid');report.results.push({mode:'valid',...await r.json()});break;}catch{await new Promise(r=>setTimeout(r,50));}}
  for(const mode of Object.keys(ports).slice(1))report.results.push({mode,...await(await fetch('http://127.0.0.1:'+httpPort+'/'+mode)).json()});
  assert.equal(report.results.length,7);assert.equal(report.results[0].success,true);
  assert.equal(report.results[0].result.proofVerified,true);assert.equal(report.results[0].result.tlsNameVerified,undefined);
  for(const result of report.results.slice(1))assert.equal(result.success,false,result.mode);
  report.safetyTestsPassed=true;report.runtimeReady=true;
 }finally{
  if(worker&&worker.exitCode===null&&worker.signalCode===null){worker.kill('SIGTERM');await new Promise(resolve=>worker.once('exit',resolve));}
  for(const server of servers)await close(server);
  report.log=childLog;fs.rmSync(directory,{recursive:true,force:true});report.cleaned=!fs.existsSync(directory);
  fs.writeFileSync(output,JSON.stringify(report,null,2));
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>console.log(JSON.stringify(report.results)));
