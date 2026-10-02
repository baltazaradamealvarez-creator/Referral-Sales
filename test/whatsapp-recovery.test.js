'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {createTransport}=require('../src/whatsapp-baileys');
const {createRetryStore}=require('../src/whatsapp-retry-store');
const PHONE='15125550142@s.whatsapp.net',LID='987654321@lid',GROUP='1203630@g.us';

async function setup(t,{canRetryMessage}={}) {
  const library=await import('@whiskeysockets/baileys');
  const authDir=fs.mkdtempSync(path.join(os.tmpdir(),'whatsapp-recovery-'));
  const fake={sockets:[],diagnostics:[],savedKeys:0,savedCreds:0,nextId:0,peers:[]};
  const lib={...library,async fetchLatestBaileysVersion(){return {version:[2,3000,1]};},
    async useMultiFileAuthState(){
      return {state:{creds:{},keys:{async set(){if(fake.keyGate)await fake.keyGate;fake.savedKeys++;}}},
        async saveCreds(){if(fake.credError)throw new Error('Fixture key-write failure');if(fake.credGate)await fake.credGate;fake.savedCreds++;}};
    },
    default(options){
      const sock={options,ev:new EventEmitter(),user:{id:'15125550100@s.whatsapp.net'},sent:[],ended:0,
        end(){this.ended++;},async logout(){},
        async sendMessage(jid,body){
          if(fake.sendGate)await fake.sendGate;
          const sent={key:{id:`out-${++fake.nextId}`,remoteJid:jid,fromMe:true},message:library.proto.Message.fromObject(body.text ? {conversation:body.text} : {reactionMessage:body.react})};
          this.sent.push(sent);return sent;
        },
        async onWhatsApp(){return fake.peers;},async groupFetchAllParticipating(){return {};}};
      fake.sockets.push(sock);return sock;
    }};
  const options={authDir,loadLibrary:async()=>lib,onQr(){},onOpen(){},onClose(){},onMessage(){},canRetryMessage,
    onDiagnostic:event=>fake.diagnostics.push(event)};
  const transports=[];
  const make=()=>{const transport=createTransport(options);transports.push(transport);return transport;};
  t.after(async()=>{for(const transport of transports)await transport.stop();fs.rmSync(authDir,{recursive:true,force:true});});
  const transport=make();await transport.start();
  return {fake,authDir,library,transport,make,sock:fake.sockets[0]};
}

test('WhatsApp retry hook provides only the original outgoing message for the same chat',async t=>{
  const {transport,sock,fake,authDir}=await setup(t);
  const id=await transport.sendText(PHONE,'Original message with customer@example.com');
  const message=await sock.options.getMessage({id,remoteJid:PHONE,fromMe:true});
  assert.equal(message.conversation,'Original message with customer@example.com');
  assert.equal(await sock.options.getMessage({id,remoteJid:'15125550999@s.whatsapp.net'}),undefined);
  assert.equal(await sock.options.getMessage({id:'not-sent',remoteJid:PHONE}),undefined);
  assert.equal(sock.sent.length,1,'fetching an original does not create a new message');
  assert.ok(fake.diagnostics.some(e=>e.kind==='retry_available'));
  assert.ok(fake.diagnostics.some(e=>e.kind==='retry_blocked'));
  assert.ok(fake.diagnostics.some(e=>e.kind==='retry_missing'));
  const encrypted=fs.readFileSync(path.join(authDir,'message-retry.enc'));
  assert.equal(encrypted.includes(Buffer.from('customer@example.com')),false);
  assert.equal(encrypted.includes(Buffer.from(PHONE)),false,'chat identities are also encrypted');
  assert.equal(fs.statSync(path.join(authDir,'message-retry.key')).mode & 0o777,0o600);
});

test('original messages survive a transport restart without replaying chats',async t=>{
  const {transport,sock,make,fake}=await setup(t);
  const id=await transport.sendText(PHONE,'Recover this after deploy');await transport.stop();
  const rebooted=make();await rebooted.start();const next=fake.sockets[1];
  assert.equal((await next.options.getMessage({id,remoteJid:PHONE})).conversation,'Recover this after deploy');
  assert.equal(next.sent.length,0);assert.equal(sock.sent.length,1);
});

test('phone and privacy-ID retry aliases stay bound to their original recipient across restarts',async t=>{
  const {transport,sock,make,fake}=await setup(t);
  fake.peers=[{jid:PHONE,lid:LID,exists:true}];assert.equal(await transport.exists('15125550142'),PHONE);
  const id=await transport.sendText(PHONE,'Private original');
  assert.equal((await sock.options.getMessage({id,remoteJid:'987654321:4@lid'})).conversation,'Private original');
  fake.peers=[{jid:'15125550999@s.whatsapp.net',lid:'123456789@lid',exists:true}];await transport.exists('15125550999');
  assert.equal(await sock.options.getMessage({id,remoteJid:'123456789@lid'}),undefined,'an unrelated known alias cannot retrieve another chat');
  await transport.stop();const rebooted=make();await rebooted.start();
  assert.equal((await fake.sockets[1].options.getMessage({id,remoteJid:LID})).conversation,'Private original');
});

test('encryption retries cannot replay acknowledgments or old interactive lead text into quiet groups',async t=>{
  let quiet=false;
  const {transport,sock}=await setup(t,{canRetryMessage:r=>!quiet || (r.quiet && ['lead','test_lead'].includes(r.kind))});
  const oldAck=await transport.sendText(GROUP,'Old acknowledgment',{kind:'chat',quiet:false});
  const oldLead=await transport.sendText(GROUP,'Old lead with portal link',{kind:'lead',quiet:false});
  const quietLead=await transport.sendText(GROUP,'Clean lead',{kind:'lead',quiet:true});
  const testLead=await transport.sendText(GROUP,'[TEST] Clean sample',{kind:'test_lead',quiet:true});
  assert.ok(await sock.options.getMessage({id:oldAck,remoteJid:GROUP}));quiet=true;
  assert.equal(await sock.options.getMessage({id:oldAck,remoteJid:GROUP}),undefined);
  assert.equal(await sock.options.getMessage({id:oldLead,remoteJid:GROUP}),undefined);
  assert.equal((await sock.options.getMessage({id:quietLead,remoteJid:GROUP})).conversation,'Clean lead');
  assert.equal((await sock.options.getMessage({id:testLead,remoteJid:GROUP})).conversation,'[TEST] Clean sample');
  assert.equal(await sock.options.getMessage({id:quietLead,remoteJid:PHONE}),undefined);
});

test('shutdown waits for credential and Signal-key saves before completing',async t=>{
  const {transport,sock,fake}=await setup(t);let releaseKeys,releaseCreds;
  fake.keyGate=new Promise(resolve=>{releaseKeys=resolve;});fake.credGate=new Promise(resolve=>{releaseCreds=resolve;});
  const writing=sock.options.auth.keys.set({session:{fixture:{}}});sock.ev.emit('creds.update',{});
  let stopped=false;const stopping=transport.stop().then(()=>{stopped=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);assert.equal(sock.ended,1);
  releaseKeys();releaseCreds();await writing;await stopping;
  assert.equal(fake.savedKeys,1);assert.equal(fake.savedCreds,1);assert.equal(stopped,true);
});

test('shutdown also waits for an in-flight outgoing message and its retry-cache write',async t=>{
  const {transport,make,sock,fake}=await setup(t);let release;
  fake.sendGate=new Promise(resolve=>{release=resolve;});
  const sending=transport.sendText(PHONE,'Finish before shutdown');let stopped=false;
  const stopping=transport.stop().then(()=>{stopped=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);
  release();const id=await sending;await stopping;assert.equal(sock.sent.length,1);
  fake.sendGate=null;const rebooted=make();await rebooted.start();
  assert.equal((await fake.sockets[1].options.getMessage({id,remoteJid:PHONE})).conversation,'Finish before shutdown');
});

test('session-save failures produce diagnostics and logout removes cached originals with the session',async t=>{
  const {transport,sock,fake,authDir}=await setup(t);
  await transport.sendText(PHONE,'Clear with logout');fake.credError=true;sock.ev.emit('creds.update',{});
  await new Promise(resolve=>setImmediate(resolve));assert.ok(fake.diagnostics.some(e=>e.kind==='auth_save_error'));
  await transport.logout();assert.equal(fs.existsSync(authDir),false);
});

test('retry storage bounds retention and rejects tampering without exposing message text',async t=>{
  const {authDir,library}=await setup(t);let now=10000;const diagnostic=[];
  const options={codec:library.proto.Message,normalizeJid:library.jidNormalizedUser,limit:2,ttlMs:1000,now:()=>now,onDiagnostic:e=>diagnostic.push(e)};
  const store=createRetryStore(authDir,options);
  const put=id=>store.put({key:{id,remoteJid:PHONE},message:library.proto.Message.fromObject({conversation:`Message ${id}`})},PHONE);
  put('a');put('b');put('c');assert.equal(store.get({id:'a',remoteJid:PHONE}),undefined);
  assert.equal(store.get({id:'c',remoteJid:PHONE}).conversation,'Message c');
  const file=path.join(authDir,'message-retry.enc'),data=fs.readFileSync(file);data[data.length-1]^=1;fs.writeFileSync(file,data);
  const corrupt=createRetryStore(authDir,options);assert.equal(corrupt.get({id:'c',remoteJid:PHONE}),undefined);
  assert.ok(diagnostic.some(e=>e.kind==='retry_cache_error'));
  now+=1001;assert.equal(store.get({id:'c',remoteJid:PHONE}),undefined);
});

test('app retry policy follows current quiet-group selection and exposes content-free diagnostics',async t=>{
  const {openDb}=require('../src/db'),{createApp,ensureAdmin}=require('../src/app');const db=openDb(':memory:');let handlers;
  db.exec(`INSERT INTO settings(key,value) VALUES('wa_enabled','1'),('wa_group_id','${GROUP}'),('wa_group_mode','interactive');`);
  const app=createApp(db,{whatsappTransport:h=>{handlers=h;return {async start(){},async stop(){}};}});
  const admin=ensureAdmin(db,()=>{}),server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
  await app.locals.whatsapp.start();t.after(async()=>{await app.locals.whatsapp.stop();await new Promise(resolve=>server.close(resolve));db.close();});
  assert.equal(handlers.canRetryMessage({chat:GROUP,kind:'chat',quiet:false}),true);
  db.prepare("UPDATE settings SET value='quiet' WHERE key='wa_group_mode'").run();
  assert.equal(handlers.canRetryMessage({chat:GROUP,kind:'chat',quiet:false}),false);
  assert.equal(handlers.canRetryMessage({chat:GROUP,kind:'lead',quiet:false}),false);
  assert.equal(handlers.canRetryMessage({chat:GROUP,kind:'lead',quiet:true}),true);
  assert.equal(handlers.canRetryMessage({chat:'unknown@g.us',kind:'lead',quiet:true}),false);
  assert.equal(handlers.canRetryMessage({chat:PHONE,kind:'chat',quiet:false}),true);
  db.prepare("UPDATE settings SET value='0' WHERE key='wa_enabled'").run();
  assert.equal(handlers.canRetryMessage({chat:PHONE,kind:'chat',quiet:false}),false);
  handlers.onDiagnostic({kind:'retry_request'});handlers.onDiagnostic({kind:'retry_missing'});
  handlers.onDiagnostic({kind:'auth_save_error'});
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const login=await fetch(base+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:admin.username,password:admin.password})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  await fetch(base+'/me/password',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({current:admin.password,next:'recovery-admin-pass-1'})});
  const response=await fetch(base+'/whatsapp/status',{headers:{Cookie:cookie}});assert.equal(response.status,200);
  const {diagnostics}=await response.json();assert.equal(diagnostics.retry_requests,1);assert.equal(diagnostics.retry_missing,1);assert.equal(diagnostics.auth_save_errors,1);
  assert.ok(diagnostics.last_retry_at);assert.match(diagnostics.last_error,/encryption keys/);
  assert.equal(JSON.stringify(diagnostics).includes(PHONE),false);
});
